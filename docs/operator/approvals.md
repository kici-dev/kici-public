---
title: Approval gates
description: Configure approvers, expiry, and self-approval; manage the dashboard approval queue and the approve/reject flow
---

An approval gate holds a workflow element — a step, a job, or a whole run — until an authorized person approves it. This guide covers the operator side: defining the approvers (teams), the org-level expiry and self-approval settings, the dashboard approval queue, the approve/reject flow, and the agent-occupancy consideration for step-level holds.

Workflow authors declare gates with `approval` (see [Approval gates (user guide)](../user/approvals.md)). The same held-element mechanism also backs the **required reviewers** protection rule on an environment, so everything below applies to both the explicit (author-declared) and mandatory (environment-policy) gates.

## Approvers: teams and users

An approval clause names either a **team** or a **user**:

- `{ team: 'leads' }` is released when any member of the `leads` team approves.
- `{ user: 'cto' }` is released when that specific user approves.

Workflow code may _name_ a team but can never define its membership — teams are operator-defined data. That boundary is what makes a `{team}` clause a real control: a malicious change can name `{team: 'leads'}`, but it cannot add itself to `leads`.

### Defining teams

Teams are managed two ways:

- **Dashboard Teams tab** — on the org settings page, gated by the `teams` permission (`teams:read` to view, `teams:admin` to edit). Create, rename, and delete teams; add and remove members from a picker over your org members; attach roles to a team so the whole team inherits the role's permissions.
- **Break-glass CLI** — the platform admin CLI's `team` subcommands (`create`, `list`, `show`, `add-member`, `remove-member`, `assign-role`, `revoke-role`, `delete`) write directly to the control-plane database, are idempotent and transactional, and record an audit entry per change.

A team member must also be a member of the org. Membership changes propagate to the orchestrator automatically, so a clause is always evaluated against the current team roster.

### Who may approve

Releasing any held element requires the `environments:write` or `ci_trust:write` permission **and** eligibility for at least one unsatisfied clause (membership in a named team, or being a named user). The coarse permission is the gate to act on approvals at all; the per-clause eligibility is the fine-grained check on top. Naming a team in a workflow does not grant anyone approval rights — it only restricts which already-permitted users can release that specific gate.

## Org settings

Two org-scoped settings govern approval behavior. Manage them with the orchestrator admin CLI:

```bash
# Show the current approval settings for an org
kici-admin org-settings approval show --customer-id <id>

# Set the default hold expiry (seconds)
kici-admin org-settings approval set-expiry <seconds> --customer-id <id>

# Allow or forbid self-approval
kici-admin org-settings approval set-self-approval true|false --customer-id <id>
```

| Setting                   | Default | Effect                                                                                                      |
| ------------------------- | ------- | ----------------------------------------------------------------------------------------------------------- |
| `approval_expiry_seconds` | `86400` | Default time a held element waits before it expires (and the run fails). A per-gate `timeout` overrides it. |
| `allow_self_approval`     | `true`  | Whether the person who triggered the run may approve their own gate.                                        |

### Expiry

A held element waits up to its expiry — the per-gate `timeout` if the workflow set one, otherwise `approval_expiry_seconds`. When the deadline passes without all clauses satisfied, the element is rejected and the run fails. The stale run detector sweeps overdue holds on each scan cycle; a step-level hold that expires also signals the waiting agent to fail the job. Set `approval_expiry_seconds` to a value that matches how long your reviewers realistically take — long enough to avoid spurious failures, short enough that a forgotten gate does not tie up resources indefinitely (see [agent occupancy](#agent-occupancy-during-step-level-holds)).

### Self-approval

With `allow_self_approval` set to `false`, the user who triggered a run cannot approve a gate on that run; another eligible approver must. This is the control for environments where author sign-off must be independent. It defaults to `true` because an author's _voluntary_ gate is usually a reminder for themselves; the mandatory environment-reviewer layer remains the real control for untrusted contributors.

## The dashboard approval queue

The approval queue page lists held elements pending approval. It shows held runs at all three scopes (step, job, workflow) — the `Scope` column carries a badge for each — and, for each, the **per-clause progress** — which clauses are satisfied and by whom, and how many remain (for example, `leads ✓ · cto ✗ — 1/2`). Each decision is attributed to the real approver. Approve and reject actions are available to users with the required permission; the run detail page shows who approved each clause.

A `workflow`-scoped row covers a whole workflow dispatch. One source of these is the **private-registry install gate**: when a workflow's `registries:` / `installEnv:` names a reviewer-gated environment, the install gate pauses the whole dispatch as a `held` run (job id `__install__<workflow>`) until an approver releases it. Approving resumes the dispatch and lets its jobs run; rejecting cancels the run before any job starts. See [Private registries](../user/private-registries.md#reviewer-gated-installs).

A held-for-approval status check is also posted back to the source provider for job- and workflow-level holds, naming the unsatisfied clauses. Step-level holds run inside the agent mid-job, so the provider check stays at job granularity.

## Approving and rejecting

A held element is released the same way regardless of whether it was held by an explicit `approval` gate or a mandatory environment reviewer policy:

- **Dashboard** — approve or reject from the approval queue.
- **`kici approve` / `kici reject`** — the developer CLI, acting as the authenticated user. See [`kici approve`](../user/approvals.md#approving-from-the-cli).

Both paths run through the same eligibility check and the same resume logic: on full satisfaction the held element is re-dispatched (for a job or workflow) or unblocked (for a step); any single rejection fails the element and the run.

## Agent occupancy during step-level holds

A **step-level** hold pauses a job mid-execution. To preserve the workspace and all prior-step state across the wait, the agent and its workspace stay live and occupied for the entire human wait — the agent keeps sending heartbeats so it is not reaped, but it cannot be reused for other work until the gate resolves.

Plan capacity accordingly:

- Set a sane `approval_expiry_seconds` (or per-gate `timeout`) so an unanswered step gate cannot occupy an agent indefinitely.
- Prefer job- or workflow-level gates when the approval does not need to land mid-job with prior-step state intact — those hold a `held_runs` row, not a live agent.
- If many concurrent runs use step-level gates, size your agent pool to absorb the holds without starving normal dispatch.

## See also

- [Approval gates (user guide)](../user/approvals.md) — authoring `approval`.
- [Environments](environments.md) — required reviewers and the held-run lifecycle.
- [Approval gates (architecture)](../architecture/approvals.md) — the unified hold model and the step-level round-trip.
- [kici-admin CLI](orchestrator/kici-admin-cli.md) — the `org-settings approval` subcommand.
