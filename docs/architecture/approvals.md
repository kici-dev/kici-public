---
title: Approval holds
description: The unified one-hold/two-trigger approval model, clause evaluation and resume, and the step-level agent round-trip
---

KiCI gates execution on human approval at step, job, and workflow granularity. Every gate, whatever its source, produces the same artifact — a **held element** that pauses execution until its approval requirement is satisfied, rejected, or expired. This page describes the unified model and the step-level round-trip that lets a hold land mid-job.

For authoring gates see [Approval gates (user guide)](../user/approvals.md); for operating them see [Approval gates (operator guide)](../operator/approvals.md).

## One hold, two triggers

Two independent sources can hold an element. They differ only in **what triggers** the hold and **where the approver requirement comes from** — both funnel into the same held-element mechanism.

| Source        | Trigger                             | Requirement source                                   | Granularity           |
| ------------- | ----------------------------------- | ---------------------------------------------------- | --------------------- |
| **Mandatory** | element targets a protected context | context policy (required reviewers)                  | job                   |
| **Explicit**  | author wrote `approval` in the SDK  | the clauses in code, resolved against operator teams | step / job / workflow |

The explicit `approval` declaration is compiled into the lock file's `approval` block (at the matching step, job, or workflow node). The mandatory requirement is resolved at dispatch time from the context's reviewer policy. Both normalize to one shape before the gate evaluates them:

```
ApprovalRequirement = {
  clauses: ApproverClause[]   // AND — all must be satisfied
  expiresAt: timestamp
  reason: string
}
ApproverClause = { team: string } | { user: string }
```

When both a mandatory context hold and an explicit hold apply to the same job, their clauses are combined into one requirement (AND), so both sources must be satisfied.

## Approval holds vs security holds

A third kind of hold shares the same `held_runs` storage but is **not** an approval hold. It is the **security hold**, raised by the CI-trust layer when code from an untrusted ref must be vetted before it runs at all.

Both kinds pause execution and both are released by a human. They answer different questions: "should this change be promoted?" versus "is it safe to execute code from this ref?". So they are kept in two separate queues, and a permission to do one never grants the other.

|                                   | Approval hold                                                                                                     | Security hold                                                                                                                           |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Queue (`held_runs.queue_type`)    | `context`                                                                                                         | `security`                                                                                                                              |
| Hold type (`held_runs.hold_type`) | `reviewer` (also `timer` and `concurrency` for the other context gates)                                           | `security`                                                                                                                              |
| Raised by                         | an `approval` gate in workflow code, or a context's required-reviewer policy                                      | the CI trust layer: the org fork switch holds a fork pull request, or a context's `minimumTrust` blocks a fork run                      |
| Requirement                       | an `ApprovalRequirement` — an AND-list of team/user clauses with per-clause progress and per-approver attribution | a single reason — `fork_pr` from the org policy, `context_trust` from the per-context gate; any sufficiently-trusted member releases it |
| Granularity                       | step, job, or workflow                                                                                            | the whole run (org trust policy) or one job (trust gate)                                                                                |
| Released by                       | `contexts:write` (a `timer` hold takes `contexts:admin`) **and** eligibility for an unsatisfied clause            | `ci_trust:write` or higher, as resolved through any per-member `ci_trust_override`                                                      |
| Release channels                  | dashboard approval queue, `kici approve` / `kici reject`                                                          | dashboard CI-trust approval queue, `/kici approve` / `/kici reject` in a PR comment                                                     |
| Provider status check             | a held-for-approval check naming the unsatisfied clauses                                                          | a fixed `KiCI Security` check updated in place                                                                                          |

The queue split is enforced at release time, not only in the UI: a release that targets the security queue asserts the row's `queue_type` matches, so a context approval can never release a security hold and vice versa.

Two further `held_runs.reason` values exist in the stored vocabulary but are no longer raised: `workflow_modification` and `unknown_contributor`. The org trust policy is the fork switch alone. A `.kici/` modification is reported on its own informational check instead of feeding a policy arm, and contributor identity no longer gates dispatch. Rows written by earlier builds still carry those two reasons, so the queue renders them. Both are removed at v1.0.0 (see [deprecations](../user/deprecations.md)).

### A job held by both kinds

The two kinds are independent, so one job can carry an approval hold and a security hold at the same time. Two configurations reach it: an `approval` gate on a job whose run came from a fork, and a context that sets both required reviewers and `minimumTrust`.

Each writes its own `held_runs` row, and **both** must be released before the job runs. Nothing merges them: the requirements come from different authorities and take different permissions, so satisfying one says nothing about the other. The mechanism is the pending-hold check itself — a job with any pending row stays held, so the second row keeps gating after the first is released.

Two consequences follow from there being two rows rather than one.

The rows carry **independent expiries**, and whichever deadline arrives first cancels the run. The approval row uses the gate's own `timeout`, or the org's `approval_expiry_seconds` when the gate set none. The `context_trust` row uses the context's `hold_expiry_seconds`. Their defaults differ by a factor of 24, so the security row is usually the one that expires first.

The commit still carries **one** `KiCI Security` check run, shared by every hold on that commit. It stays pending until every hold that owns it has ended, so releasing one never turns the check green while the other still gates the job. Its description renders the approval clauses and appends a line naming the trust hold, the permission that clears it, and the `/kici approve` command. Without that line the named approver approves, the job does not run, and the text does not change.

Because a `--job` selector names both rows at once, `kici approve` and `kici reject` take `--hold-type <type>` and `--hold <id>` to pick one.

Everything below this section describes **approval** holds. For the security side see [CI security](security/ci-security.md#security-approval-queue).

## Clause evaluation

A requirement is satisfied when **all** of its clauses are satisfied:

- `{ team: T }` is satisfied once any member of team `T` approves.
- `{ user: U }` is satisfied once `U` approves.
- An empty clause list (`approval: true`) is satisfied by a single approval from any approval-capable member.

Clauses are a flat AND list; one qualifying approver may satisfy several clauses at once (an approver who is both in team `leads` and is user `cto` satisfies both clauses with one decision). Any single rejection rejects the whole element; an expired hold is treated as a rejection.

The orchestrator has no identity store of its own. Team membership and identity links arrive over the control-plane trust-policy push, or — on an independent orchestrator, which has no Platform to push them — from what the operator registered with `kici-admin trust-policy directory-set`. Clause matching and approver eligibility read only that stored directory, never anything carried on the approval request itself. This is the same trust boundary the rest of the CI-security path uses.

Each individual decision is recorded — the approver, the decision, and which clauses it satisfied — so multi-clause progress and per-approver attribution are first-class in the dashboard queue and on the run detail page. Eligibility is enforced at approve time: an actor must be eligible for at least one _unsatisfied_ clause, and self-approval is rejected when the org disables it.

## Hold lifecycle and resume

A held element uses the shared `held` status — a non-terminal value on both `ExecutionRunStatus` and `ExecutionJobStatus`. There are no approval-specific statuses — workflow- and step-level holds use the same `held` status as the existing job-level hold, and resume, reject, and expire drive it to the ordinary run/job statuses below.

```mermaid
stateDiagram-v2
    [*] --> pending
    pending --> held : gate triggers hold
    held --> queued : approval satisfied
    held --> cancelled : rejection
    held --> cancelled : expiry
```

On full satisfaction the held element is **resumed**, through one path shared by the dashboard and CLI approve flows:

- **Job or workflow scope** — the released element is re-dispatched (enqueued for dispatch). A workflow-level hold gates the run's first dispatch; releasing it lets the run's jobs proceed.
- **Step scope** — the orchestrator signals the waiting agent (see [the round-trip](#step-level-round-trip)) rather than enqueuing anything.

A rejection or an expiry instead drives the held element to `cancelled`, which fails the run. The stale run detector sweeps overdue holds and drives the expiry side.

A job whose upstream dependencies complete is re-checked against its hold rows before it dispatches, because the dependency scheduler and the approval gate are independent — the scheduler releases a job on its dependencies alone. One job can carry two hold rows at once (an explicit approval gate plus a context security gate), and the check refuses while **any** of them is still pending, so releasing one leaves the other gating. If that check cannot read the hold rows at all, it retries briefly and then refuses: the job stays pending and is re-driven by the next release or by the scheduler recovery pass on the next orchestrator start. A delayed job is recoverable; a job dispatched past an unread approval gate is not.

### Which release surfaces a deployment has

The approve and reject surfaces differ by deployment, because two of the three reach the orchestrator through the Platform.

| Surface                                              | Releases                                          | Platform-attached       | Independent                                                             |
| ---------------------------------------------------- | ------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------- |
| Dashboard, `kici approve` / `kici reject`, MCP       | Approval **and** security holds, every scope      | Yes                     | No — all three reach the orchestrator over the control-plane connection |
| `/kici approve` / `/kici reject` on the pull request | Security holds only                               | Yes                     | Yes                                                                     |
| `kici-admin held-run approve` / `reject`             | Approval **and** security holds, job and workflow | No — refuses with a 409 | Yes                                                                     |

The three do not overlap by accident. The first two authorize a **person**: the dashboard and `kici approve` resolve the acting member's org RBAC on the Platform, and `/kici approve` resolves a pull-request commenter through the org's identity links. `kici-admin held-run` authorizes an **operator token** against the orchestrator's own RBAC. That is why it is the one surface that refuses wherever a Platform is attached: the Platform is the authority there, and a locally-taken decision would land a release its gate never saw.

`/kici approve` is scoped to the security queue by design. It authorizes a pull-request commenter, and an approval gate on a deployment context is not a decision a commenter on that pull request should make. `kici-admin held-run` carries no such scoping, because an operator on a Platform-less orchestrator is the only authority there is. It does exclude step scope, whose release is a notification to the waiting agent rather than a re-dispatch.

Whichever surface ends a hold, the decision goes through the same applier. The requirement's clauses still have to be satisfied, the decision is recorded in `held_run_approvals`, and a released job or workflow is re-dispatched rather than merely marked approved.

## Step-level round-trip

A step-level gate must pause a job _mid-execution_, after earlier steps have run, with the workspace and prior-step state intact. The agent runs a job as one unit, so this requires a round-trip between the agent and its orchestrator over two protocol messages on the [orchestrator ↔ agent](protocol/orchestrator-agent.md) channel.

```mermaid
sequenceDiagram
    participant Agent
    participant Orchestrator
    participant Approver

    Note over Agent: runs earlier steps
    Agent->>Orchestrator: step.approval-request<br/>(runId, jobId, stepIndex, requirement)
    Note over Orchestrator: create step-scoped held element
    Note over Agent: blocks step loop,<br/>keeps heartbeating
    Approver->>Orchestrator: approve (dashboard / kici approve)
    Note over Orchestrator: all clauses satisfied → release
    Orchestrator->>Agent: step.approval-resolved<br/>(outcome: approved)
    Note over Agent: runs the held step,<br/>then continues the job
```

- **`step.approval-request`** (agent → orchestrator) carries `runId`, `jobId`, `stepIndex`, `stepName`, and the normalized `requirement`. The orchestrator creates a step-scoped held element for it.
- The agent blocks its step loop and `await`s resolution, keeping the sandbox and workspace live. Heartbeats continue throughout so the agent is not reaped while waiting.
- **`step.approval-resolved`** (orchestrator → agent) carries `requestId` (correlating to the request), `runId`, `jobId`, `stepIndex`, and an `outcome` of `approved`, `rejected`, or `expired`. On `approved` the agent runs the held step against its intact workspace and continues the job. On `rejected` or `expired` it fails the job with a clear reason.

These two messages are ordinary protocol messages; they do not affect the heartbeat and log-chunk fast paths.

Because a step-level hold keeps an agent and workspace occupied for the whole wait, it is bounded by the hold's expiry. Operators size this with `approval_expiry_seconds` (or a per-gate `timeout`); see the [agent-occupancy note](../operator/approvals.md#agent-occupancy-during-step-level-holds).

## See also

- [Approval gates (user guide)](../user/approvals.md) — authoring `approval`.
- [Approval gates (operator guide)](../operator/approvals.md) — teams, the queue, expiry, self-approval.
- [Execution status vocabulary](execution/state-machine.md) — the `held` status and the terminal-state rules.
- [Orchestrator ↔ Agent messages](protocol/orchestrator-agent.md) — the protocol channel the step round-trip rides.
