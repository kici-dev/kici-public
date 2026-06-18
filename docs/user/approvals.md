---
title: Approval gates
description: Pause a workflow for human sign-off at step, job, or workflow granularity with requireApproval
---

An **approval gate** pauses execution until an authorized person approves it. Execution resumes from exactly where it paused; a rejection (or an expired hold) fails the run.

You declare a gate in your workflow with `requireApproval`. It is available at three levels of granularity:

- **Step** — pause mid-job, before a specific step runs. The agent holds the live workspace (with all prior-step state intact) for the duration of the wait.
- **Job** — hold the job before any of its steps run.
- **Workflow** — hold the whole run before any job is dispatched.

Approvers are named as **teams** and **users**. A team is an operator-defined group of org members; your workflow code may name a team but can never change its membership, which is what makes a team clause a real gate rather than a suggestion. See [Approval gates (operator guide)](../operator/approvals.md) for how operators define teams, the approval queue, and expiry; see [the architecture overview](../architecture/approvals.md) for how a hold is evaluated and resumed.

## Quick start

Hold a deploy job until a member of the `leads` team approves:

```typescript
import { workflow, job, step, push } from '@kici-dev/sdk';

export default workflow('deploy', {
  on: [push({ branches: ['main'] })],
  jobs: [
    job('deploy-production', {
      runsOn: 'default',
      requireApproval: [{ team: 'leads' }],
      steps: [step('deploy', async (ctx) => ctx.$`deploy --prod`)],
    }),
  ],
});
```

When the run reaches this job, it is held instead of dispatched. The held run appears in the dashboard approval queue and can be released from there or with the [`kici approve`](#approving-from-the-cli) command. Once a member of `leads` approves, the job dispatches normally.

## The `requireApproval` field

`requireApproval` accepts three forms.

### Shorthand: `true`

```typescript
job('deploy', {
  runsOn: 'default',
  requireApproval: true,
  steps: [
    /* ... */
  ],
});
```

`requireApproval: true` holds the element until **any** org member who can act on approvals signs off — anyone with the `environments:write` or `ci_trust:write` permission. Use it when you want a manual gate without restricting who may release it.

### Approver list (AND)

```typescript
requireApproval: [{ team: 'leads' }, { user: 'cto' }],
```

A list of approver clauses is an **AND** list: every clause must be satisfied before the element is released.

- `{ team: 'leads' }` is satisfied once **any** member of the `leads` team approves.
- `{ user: 'cto' }` is satisfied once the user `cto` approves.

A single approver may satisfy more than one clause. If `cto` is also a member of `leads`, one approval from `cto` satisfies both `{ team: 'leads' }` and `{ user: 'cto' }`, releasing the element. A user is named by their KiCI user identifier (their linked identity), and a team by its name as defined by your operator.

There is no OR or nested logic — clauses are always a flat AND list.

### Object form: reason and timeout

```typescript
requireApproval: {
  approvers: [{ team: 'security' }, { team: 'leads' }],
  reason: 'Production deploy requires security + leads sign-off',
  timeout: 7200, // seconds
},
```

| Field       | Type               | Description                                                                                         |
| ----------- | ------------------ | --------------------------------------------------------------------------------------------------- |
| `approvers` | `ApproverClause[]` | The AND list of `{ team }` / `{ user }` clauses. An empty list means "any approval-capable member". |
| `reason`    | `string`           | A human-readable label shown in the dashboard queue and the held-for-approval status check.         |
| `timeout`   | `number`           | Per-gate expiry in **seconds**, overriding the org default. On expiry the element is rejected.      |

When `timeout` is omitted, the gate uses the org's default approval expiry (set by the operator). On expiry, the held element is rejected and the run fails — see [expiry](../operator/approvals.md#expiry).

## Granularity

The same `requireApproval` field is accepted on a workflow, a job, and a step.

### Workflow-level

A workflow-level gate holds the entire run before any job is dispatched:

```typescript
export default workflow('release', {
  on: [push({ branches: ['main'] })],
  requireApproval: [{ team: 'release-managers' }],
  jobs: [buildJob, publishJob],
});
```

### Job-level

A job-level gate holds just that job; other jobs in the run proceed normally:

```typescript
job('publish', {
  runsOn: 'default',
  requireApproval: [{ team: 'leads' }],
  steps: [
    /* ... */
  ],
});
```

### Step-level

A step-level gate pauses mid-job, immediately before the named step. Earlier steps in the job have already run and their workspace state is preserved across the wait:

```typescript
job('migrate-and-deploy', {
  runsOn: 'default',
  steps: [
    step('build-plan', async (ctx) => ctx.$`./gen-migration-plan.sh`),
    step('apply-migration', {
      requireApproval: [{ team: 'dba' }],
      run: async (ctx) => ctx.$`./apply-migration.sh`,
    }),
    step('deploy', async (ctx) => ctx.$`deploy --prod`),
  ],
});
```

Here `build-plan` runs, then the job pauses for a `dba` approval. On approval, `apply-migration` runs against the exact workspace `build-plan` produced, followed by `deploy`. A rejection or expiry fails the job.

Because a step-level hold keeps an agent and its workspace occupied for the whole human wait, prefer job- or workflow-level gates when you do not need prior-step state, and keep step-level timeouts short. See the [operator note on agent occupancy](../operator/approvals.md#agent-occupancy-during-step-level-holds).

## Mandatory vs. explicit gates

`requireApproval` is the **explicit** gate — a deliberate "pause for a human here" written by the workflow author. It composes with the **mandatory** gate an operator can attach to a protected environment via required reviewers (see [Environments](environments.md#required-reviewers)). When both apply to the same job, all clauses from both sources must be satisfied before the job is released. The two funnel into one held-element mechanism, so the dashboard queue and `kici approve` work the same way regardless of which source held the element.

## Approving from the CLI

Approve or reject a held element with the `kici` CLI:

```bash
# Approve a workflow-level hold
kici approve <run-id>

# Approve a held job
kici approve <run-id> --job deploy-production

# Approve a held step
kici approve <run-id> --job migrate-and-deploy --step apply-migration

# Reject (a reason is required)
kici reject <run-id> --job deploy-production --reason "Wrong release branch"
```

You must be eligible for at least one unsatisfied clause — being a member of a named team or being a named user. The orchestrator verifies eligibility against the operator-defined teams, so naming a team in your workflow can never let an ineligible person release the gate. The command reports whether the element was released, how many clauses remain, or that it was rejected. See [`kici approve`](cli-reference.md#kici-approve) for the full command reference.

You can also approve from the dashboard approval queue. See [Dashboard](dashboard/environments-and-secrets.md#approval-queue).

## See also

- [Environments](environments.md) — operator-required reviewers on protected environments.
- [Approval gates (operator guide)](../operator/approvals.md) — teams, the approval queue, expiry, and self-approval.
- [Approval gates (architecture)](../architecture/approvals.md) — the unified hold model and the step-level round-trip.
