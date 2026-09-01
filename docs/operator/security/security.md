---
title: CI security
description: The fork switch, context minimum trust, security approvals, and monitoring
---

KiCI protects your pipelines from unauthorized code execution. Trust comes from the **git ref** an event carries. A ref that lives in your repository is trusted, because only a contributor with write access can put a ref there. A ref that comes from a fork is untrusted, and a fork pull request always runs with reduced privilege — or does not run at all.

This guide covers the organization's fork switch, the per-context minimum-trust gate, the security approval queue, and what to monitor.

## The fork switch

One organization-level setting decides what happens to a pull request from a fork. Configure it in the dashboard under **Settings > CI trust**.

| Setting         | Values                      | Default  | What it does                                                 |
| --------------- | --------------------------- | -------- | ------------------------------------------------------------ |
| Fork PR policy  | `ignore` / `hold` / `allow` | `ignore` | Drop fork pull requests, hold them for approval, or run them |
| Approval expiry | Duration                    | 72 hours | How long a security hold stays approvable before it expires  |

- **`ignore`** drops the event before anything is dispatched. There is no run, no check run, and nothing on the pull request. The delivery is still recorded in the event log.
- **`hold`** creates the run, holds it, and posts a pending `KiCI Security` check. Approving it runs the workflow — still untrusted.
- **`allow`** runs the workflow immediately, untrusted.

`reject` is a deprecated fourth value that behaves as `ignore`. A stored `reject` keeps working; set `ignore` when you next change the policy.

Nothing else about a fork pull request is configurable. There is no separate policy for unknown contributors and no separate policy for workflow changes — both are answered by the ref itself.

### Defaults and fail-closed behaviour

- An organization that has never opened **Settings > CI trust** has no stored policy, and its orchestrator applies `ignore`. That state can last indefinitely, because the policy is created on the first dashboard read.
- If the orchestrator cannot **read** its stored policy, it applies `hold` instead. A read failure says nothing about what you chose, so fork pull requests are parked visibly rather than dropped silently. Both answers are fail-closed; the hold is the one you can act on.

The switch applies to sources that model forks — GitHub today. A generic webhook, a local source, or a plain Git remote has no fork signal, so a pull request from one resolves no trust tier and never reaches the switch.

### What an allowed or approved fork pull request may do

A dispatched fork run always carries three reductions:

- Workflow definitions are read from the **base branch**, so a workflow change on the fork ref does not take effect until it is merged.
- The run carries **no install or registry secrets**, so an install from a private registry fails on the first private dependency.
- **Build-cache writes** are confined to that run. A restore still falls back to the organization-shared cache, so the run reads what trusted runs saved but never overwrites it.

Approving a hold means "let this run", never "make this trusted". The approved run replays under the same trust resolution and carries the same reductions. Every provider check on such a run carries a note naming them.

Because the fork run evaluates base-branch definitions, a fork pull request that edits `.kici/` is **not** held for that reason on `allow` — the edited definitions are inert for that run. The change is reported on its own neutral check, `KiCI: Workflow changes`, so a reviewer still sees it.

### Organization-wide global workflows

Organization-wide global workflows do not run for a pull request the fork switch holds. Approving the hold releases the pull request's own workflows; it does not retroactively run the organization's global workflows for that event. A separate neutral check, `KiCI: Organization workflows`, reports that they were skipped, so the `KiCI Security` check keeps showing the hold.

This matters because a global workflow runs with **organization** credentials against the pull request's head commit. Letting one run for an untrusted event would defeat the policy that held the event in the first place.

The master switch that turns global workflows on at all is **operator-held and fleet-wide** (`cluster_settings.global_workflows_enabled`, set with `kici-admin cluster-settings`). It cannot be flipped from the dashboard — an org admin can tune the per-org authoring and source lists, but only the orchestrator operator can enable the feature for the cluster.

### Changing the policy

1. Navigate to **Settings > CI trust** in the dashboard.
2. Set the fork PR policy (`allow` for an open-source project that wants fork contributions to build, `hold` to review each one, `ignore` to refuse them).
3. Set the approval expiry — how long a held run stays approvable. Enter an amount and pick its unit (seconds, minutes, or hours), from one second up to one year. The field shows a stored window in the coarsest unit that expresses it exactly, so a 72-hour policy reads `72 hours` and a 90-second one reads `90 seconds`.
4. Save — the policy is pushed to every connected orchestrator over the WebSocket.

An **independent** orchestrator has no Platform to push the policy, so manage it with the orchestrator admin CLI instead: `kici-admin trust-policy show --customer-id <id>` and `kici-admin trust-policy set --customer-id <id> --fork-policy <ignore|hold|allow> …`. On a Platform-attached orchestrator `set` refuses with a 409, because the next Platform push would overwrite a local write. See [kici-admin: org settings](../orchestrator/kici-admin/org-settings.md).

The same applies to the approval directory an independent orchestrator resolves `/kici approve` against: `kici-admin trust-policy directory-set --customer-id <id> --user-id <id> --provider-username <name> --provider-user-id <id> --ci-trust <level>` registers an approver, and `kici-admin trust-policy directory-remove` revokes one. Both refuse with a 409 on a Platform-attached orchestrator, where the dashboard owns membership.

The admin token behind those commands needs the orchestrator-side `ci_trust.read` permission to `show` and `ci_trust.admin` to `set` — both held by the `owner` and `admin` roles, and by neither `auditor` nor a routing-key-scoped token (the policy is org-wide, not per routing key). Every successful `set` writes a `trust_policy.updated` row to the access log in the same transaction as the policy itself, so a policy change can never land unattributed; read it back with `kici-admin access-log list --action trust_policy.updated`. The two directory verbs write a `trust_directory.updated` row on the same terms, so granting someone `ci_trust:write` — which is all it takes to release a security hold — is equally attributable.

An independent orchestrator with no stored policy applies the same `ignore` default as any other. `trust-policy show` prints the values in force, so what you read is what is being applied.

### Where the policy is enforced

The policy governs both ingresses: webhooks relayed from the Platform, and those arriving on the orchestrator's own direct GitHub route (served in hybrid, independent and observed mode). One stored row decides the verdict whichever way an event arrived.

On `hold`, the run is parked in the security queue, a pending `KiCI Security` check appears on the commit, and a reviewer releases it with `/kici approve` on the pull request. Releasing it lets the run **execute**; it does not make the contributor trusted. The resumed run keeps the reduced privilege its fork ref earned: the base branch's lock file, no install or registry secrets, and an isolated cache write scope. A hold nobody answers expires after the org's approval window and cancels the run.

Approving from the dashboard, `kici approve`, or MCP needs a Platform connection, because all three reach the orchestrator over the control-plane connection. On an **independent** orchestrator the two local surfaces are `/kici approve` on the pull request, which covers security holds only, and `kici-admin held-run approve|reject`, which covers every queue. See [Answering a hold on an independent orchestrator](#answering-a-hold-on-an-independent-orchestrator).

### Answering a hold on an independent orchestrator

An independent orchestrator has no Platform, so the dashboard approval queue, `kici approve` and the MCP tools cannot reach it. `kici-admin held-run` is the local answer, and it covers every queue — a fork-policy security hold, a context's required reviewers, and a workflow's own `approval` gate alike.

```bash
# What is this run waiting for, and who may answer it?
kici-admin held-run list --customer-id <org> --run-id <run>

# Let it run.
kici-admin held-run approve --customer-id <org> --run-id <run>

# Or cancel it.
kici-admin held-run reject --customer-id <org> --run-id <run> --reason "not this one"
```

Four things to know before you use it:

- **It refuses with a 409 on a Platform-attached orchestrator.** There the Platform authorizes each decision against the acting member's org RBAC — `ci_trust:write` for a security hold, `contexts:write` or `contexts:admin` for the rest — and an orchestrator admin token carries none of that. Answer from the dashboard instead.
- **Approving lets the work run; it does not make the contributor trusted.** A released fork PR resumes with the base branch's lock file, no install or registry secrets, and an isolated cache write scope, exactly as it would have run unheld.
- **A run can carry more than one hold, and each needs its own decision.** A job gated by both a reviewer requirement and a security policy writes two rows. `list` prints them with their ids; separate them with `--job`, `--step`, `--hold-type` or `--hold <id>` — the same flags `kici approve` takes.
- **The approval is recorded as the admin token, not as a person.** The token cannot claim someone else's identity, so a hold whose `approvers:` clause names a specific user or team is only answerable if that team, in the stored approval directory, contains the token's own subject. Everything else about the decision is written to the access log as `held_run.approve` or `held_run.reject`.

The admin token needs `ci_trust.read` to `list` and `ci_trust.admin` to `approve` or `reject` — the same permissions the trust-policy verbs take, held by the `owner` and `admin` roles and by neither `auditor` nor a routing-key-scoped token. An operator who holds `ci_trust.admin` can already set the org's fork policy to `allow`, which is the blanket, permanent version of what this releases once for one hold.

Step-scoped holds are refused. Answering one means notifying the waiting agent, and an independent orchestrator has no bridge for that. Flipping the row without the notification would leave the agent waiting with nothing left to release or expire it.

## ci_trust RBAC resource

`ci_trust` is **approval authority**. It decides who may release a security hold. It does not change how much privilege a run gets — the ref decides that.

`ci_trust` is one of the 18 RBAC resources.

| Level   | Capabilities                                                                                 |
| ------- | -------------------------------------------------------------------------------------------- |
| `none`  | No CI trust capability                                                                       |
| `read`  | See the **CI trust** settings tab, which carries the fork switch                             |
| `write` | Release or reject a security hold, from the dashboard or with `/kici approve`                |
| `admin` | Change the org fork switch and approval expiry, and set another member's per-member override |

### Built-in role defaults

| Role   | ci_trust default |
| ------ | ---------------- |
| Owner  | admin            |
| Member | none             |

Members must be explicitly granted `ci_trust` through a custom role.

A per-member override supersedes the role-derived level where one is set. It is deprecated and is removed at v1.0.0 — grant the level through a role instead, directly or through a team. See [deprecations](../../user/deprecations.md).

## Context minimum trust

The `minimumTrust` protection rule on a context holds a job whose run came from a fork.

| minimumTrust | Effect                                                     |
| ------------ | ---------------------------------------------------------- |
| `trusted`    | Holds a run whose ref came from a fork                     |
| `known`      | Same effect; the value is deprecated and removed at v1.0.0 |
| (unset)      | No trust-based gating                                      |

Any value blocks the same thing, because trust is a ref-based, two-value judgement. The declared value still decides the wording of the hold reason.

A run that resolved **no** tier passes the gate — a pull request from a source with no fork model, or an internal run whose inheritance lookup failed. A run whose tier resolved `trusted` passes too.

Configure it per context under **Settings > Environments > [env] > Protection**.

### Deployment checklist: which contexts need it

`minimumTrust` is the control that stops a fork pull request from reaching a context's variables and [scoped secrets](../../user/secrets.md).

The shape to look for is a context that holds a real credential and leaves `minimumTrust` unset. Nothing about the credential itself triggers a gate. Such a context is only as protected as the fork switch, and an organization on `allow` has no gate at all.

Walk your contexts and answer three questions for each:

1. **Does this context carry a credential that can change something outside CI?** A cloud key, a registry push token, a deploy key, a production database URL. If yes, set `minimumTrust: 'trusted'`.
2. **Can a pull request reach it?** A context bound to a job that a `pullRequest()` trigger can dispatch is reachable. A context reached only by a schedule or a manual dispatch is not — but check the whole trigger set, not the workflow's name.
3. **Is the fork switch doing this job instead?** `ignore` keeps fork pull requests out entirely, so a gap is invisible until someone moves the switch to `allow`. Set the gate on the context anyway; the two controls answer different questions and an operator changing one should not silently widen the other.

A context that carries only non-sensitive variables does not need the gate. Setting it there costs you a hold on every fork pull request with nothing to protect.

## Security approval queue

Security holds sit in their own queue, separate from context approval holds and released by a different permission. Both are listed on the dashboard **Approval queue** page (`/orgs/:customerId/approval-queue`); the **CI trust** settings tab links to it.

### Hold reasons

| Reason          | Trigger                                                 | Scope         |
| --------------- | ------------------------------------------------------- | ------------- |
| `fork_pr`       | A fork pull request, with the fork switch set to `hold` | the whole run |
| `context_trust` | A context's `minimumTrust` gate blocking a fork run     | one job       |

Two further values, `workflow_modification` and `unknown_contributor`, still appear on rows written by earlier builds. Nothing raises them now.

### Approving or rejecting

**Dashboard:** click approve or reject on the **Approval queue** page. The controls render only for a hold your permissions let you act on.

**Pull-request comment:** post `/kici approve` or `/kici reject`. The commenter must hold `ci_trust:write` or higher, verified through their identity link and RBAC. The command acts only on the held runs for the pull request (and repo) the comment was posted on — it never releases or rejects holds belonging to other pull requests or repositories.

Approving a `fork_pr` hold dispatches the run, untrusted. Rejecting it cancels the run, and so does expiry. Either way the `KiCI Security` check reaches a terminal state, so branch protection is never left waiting on a hold that already ended.

### A job held twice

A job can carry a reviewer approval hold and a security trust hold at once. Both must be released before it runs: the reviewer hold takes `contexts:write` plus clause eligibility, the security hold takes `ci_trust:write`. The pull request shows one `KiCI Security` check that stays pending until both end, and its description names the second gate and the permission that clears it.

From the CLI, `--job` alone cannot separate the two. Pass `kici approve <run-id> --job <name> --hold-type security`, or `--hold <id>` when the listing shows the ids.

### Expiry

A `fork_pr` hold covers a whole pull request and is not attached to a context, so it uses the org's **Approval expiry** setting (default 72 hours). A `context_trust` hold is raised by a context, so it uses that context's own hold expiry (`hold_expiry_seconds`, default one hour), configurable under **Settings > Environments > [env] > Protection**.

The org's approval expiry is one window that can be written two ways. The dashboard edits it in whole hours. To set a window shorter than an hour, or one that is not a whole number of hours, use seconds:

- On a Platform-attached org, `PUT /api/v1/orgs/:customerId/trust-policy` accepts `approvalExpirySeconds` (integer, 1 second to 1 year). It accepts `approvalExpiryHours` too; when a request carries both, the seconds value wins, because it is the more specific of the two.
- On an independent orchestrator, `kici-admin trust-policy set --customer-id <id> --approval-expiry-seconds <n>` does the same. `--approval-expiry-hours` still works, and passing both prints a warning naming the value that is ignored.

Both spellings always move together, so they cannot disagree: setting one recomputes the other. `kici-admin trust-policy show` prints a whole-hour window as hours (`72 h`) and anything finer as seconds (`30 s`).

A job held twice carries **two** expiries, one per hold, and whichever comes first cancels the run. The security half of such a job is a `context_trust` hold, on the context's one-hour default. The reviewer half defaults to the org's `approval_expiry_seconds`, which is 24 hours. So the job is cancelled after an hour unless you raise the context's hold expiry.

An expired run transitions to `expired`, and its checks are completed with a timeout explanation.

## Identity linking

Identity links connect a provider username (for example GitHub `octocat`) to a KiCI user account. They are not part of trust resolution — no dispatch decision reads one. They exist so a `/kici approve` comment can be attributed to a KiCI user whose `ci_trust` level can then be checked.

### Auto-linking from the identity provider

When a user signs up through the identity provider with GitHub, their GitHub username is extracted from the provider's claims automatically. This is the zero-friction path that covers most users.

### OAuth linking via GitHub

For users who signed up with email and password, KiCI provides a direct GitHub OAuth flow:

1. Navigate to **Personal settings > Linked accounts** in the dashboard.
2. Click the **Link** button next to GitHub.
3. Authorize KiCI on GitHub (only `read:user` scope is requested — public profile info).
4. The link appears automatically after redirect.

#### CSRF protection

The OAuth flow uses a random state parameter to prevent authorization code injection attacks. State tokens are single-use and expire after 10 minutes.

### Unlinking

Users can unlink a provider account from their personal settings. After unlinking they can no longer approve a security hold by pull-request comment, because the comment cannot be attributed to them. The dashboard queue still works, because it authenticates the user directly.

## GitHub App permissions

Trust resolution reads the webhook payload and calls no provider API, so it needs no permission of its own. The App permissions KiCI needs are the ordinary ones — Contents, Metadata, Pull requests, and Checks. See [GitHub provider setup](../../user/providers/github.md).

## Monitoring

### Key log messages and their fields

Security events are logged as structured JSON. Each message carries its own field set:

| Message                                                 | Fields                                                     | Meaning                                      |
| ------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------- |
| `Trust tier resolved for PR`                            | `deliveryId`, `sender`, `tier`, `lockFileSource`, `reason` | Trust resolution completed for a PR event    |
| `Trust resolution failed, defaulting to base lock file` | `deliveryId`, `sender`, `error`                            | Resolution threw; the run falls back to base |
| `Fork PR event ignored by org fork policy`              | `deliveryId`, `orgId`, `repo`, `sender`                    | The fork switch dropped the event            |
| `Workflow modifications detected in PR`                 | `deliveryId`, `sender`, `tier`, `modifications`            | `.kici/` files changed in the pull request   |
| `Failed to post security hold check`                    | `runId`, `job`, `error`                                    | Check posting failed (non-blocking)          |
| `Job held by protection rules`                          | `runId`, `workflow`, `job`, `action`, `holdType`, `reason` | A job entered a hold                         |

`tier` is the resolved trust tier and `lockFileSource` is the lock file the run used (`head` or `base`). The same two values are persisted on the run row as `execution_runs.trust_tier` and `execution_runs.lock_file_source`, which is what the queries below read.

### Metrics

- `kici_orch_fork_events_ignored_total{provider}` counts fork events dropped by `ignore`. It is the only trace an ignored event leaves outside the event log, so watch it when you move an organization onto `ignore` and expect the count to track its fork pull-request volume.
- `kici_orch_trust_match_refused_no_id_total{reason}` counts identity-link matches refused for a missing or mismatched numeric id. Steady state is 0.

### Database queries

Check pending security holds:

```sql
SELECT h.id, h.run_id, h.hold_type, h.reason, h.created_at, h.expires_at,
       r.workflow_name, r.contributor_username, r.trust_tier
FROM held_runs h
JOIN execution_runs r ON r.run_id = h.run_id
WHERE h.queue_type = 'security' AND h.status = 'pending'
ORDER BY h.created_at DESC;
```

Check trust tier distribution:

```sql
SELECT trust_tier, COUNT(*) as count
FROM execution_runs
WHERE trust_tier IS NOT NULL AND created_at > NOW() - INTERVAL '7 days'
GROUP BY trust_tier;
```

### Held run expiry

The stale detector expires overdue held runs. Monitor the `held_runs` table for expired entries:

```sql
SELECT COUNT(*) FROM held_runs
WHERE status = 'expired' AND resolved_at > NOW() - INTERVAL '24 hours';
```
