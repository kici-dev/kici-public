---
title: 'SDK reference: runsOnAll host fan-out'
description: Fan one job out to every matching connected host, one pinned execution per host
---

## runsOnAll

`runsOnAll` fans a single job out to **every** host in the orchestrator's declared
roster that matches a label predicate — one pinned execution per host. Use it for
fleet-wide operations: patch every web tier, smoke-test every node, collect uptime
from the fleet.

`runsOnAll` is mutually exclusive with [`runsOn`](/user/sdk/core/): a job declares one
or the other. Where `runsOn` picks a **single** agent that satisfies the labels,
`runsOnAll` targets **all** matching hosts and runs the job once on each, pinned to
that specific host.

```typescript
import { job } from '@kici-dev/sdk';

// Run on every host labelled role:web.
const patch = job('patch', {
  runsOnAll: 'role:web',
  run: async (ctx) => {
    await ctx.$`sudo apt-get update && sudo apt-get upgrade -y`;
    ctx.log.info(`patched ${ctx.host}`);
  },
});
```

### Input forms

`runsOnAll` accepts three shapes:

- **Bare string** — one required label.

  ```typescript
  runsOnAll: 'role:web';
  ```

- **Array** — every positive entry is required (AND); a `!`-prefixed entry excludes a host.

  ```typescript
  runsOnAll: ['kici:os:linux', 'role:db', '!kici:host:db-01'];
  ```

- **Structured** — explicit OR-of-AND include groups plus excludes.

  ```typescript
  runsOnAll: {
    include: [{ all: ['kici:os:linux', 'role:db'] }, { all: ['role:replica'] }],
    exclude: ['kici:host:db-01'],
  };
  ```

  A host matches when it satisfies **any** include group (all labels in that group)
  and carries **none** of the exclude labels.

#### Targeting by pattern

Every entry in any of these forms — include or exclude — can be an exact string, a
glob, or a regular expression, exactly like [`runsOn`](./core.md#targeting-by-pattern):

- **Plain string → exact match** (`'role:web'`).
- **String with glob metacharacters (`*`, `?`, `[]`, `{}`) → glob** (`'kici:host:web-*'`).
- **`RegExp` literal → regular expression** (`/.*-canary$/`).

In the array form, a leading `!` routes an entry to the exclude side and is stripped
**before** the matching mode is decided, so `'!kici:host:box-*'` is an exclude **glob**
and `'!box-01'` an exclude **exact** match. A regular-expression exclusion uses the
structured `exclude: [/…/]` form (a `RegExp` cannot carry a `!` prefix):

```typescript
const fanout = job('deploy', {
  runsOnAll: {
    include: [{ all: ['kici:os:linux', 'kici:host:web-*'] }],
    exclude: [/.*-canary$/],
  },
  run: async (ctx) => {
    /* runs once per matched host */
  },
});
```

A custom label that literally contains glob metacharacters is always treated as a glob
and can no longer be matched exactly. A regular expression you supply is validated for
catastrophic-backtracking (ReDoS) when you run `kici compile` and rejected if it could
hang on a crafted input.

### Per-host execution model

Each matching host runs the job as its own pinned child, named `<job> (<hostname>)`
(e.g. `patch (web-01)`). The children fan in for downstream `needs:` exactly like a
matrix job — a downstream that needs the base job waits for every host child.

The job runs once per host with concurrency `unlimited` (all hosts in parallel).

### ctx.host and ctx.agent

Inside a `runsOnAll` step, two extra context fields identify the host the child is
running on:

- `ctx.host` — the hostname (string).
- `ctx.agent` — the resolved agent facts: `{ host, labels, platform?, arch? }`.

```typescript
run: async (ctx) => {
  ctx.log.info(`running on ${ctx.host} (${ctx.agent?.platform}/${ctx.agent?.arch})`);
};
```

Both are `undefined` for jobs that do not use `runsOnAll`.

### ctx.fanout — fan-out position

Every fan-out child — a `runsOnAll` host **or** a matrix combination — also
carries its **position** within the fan-out:

```typescript
ctx.fanout?: {
  index: number;   // 0-based position in the deterministically-ordered fan-out
  total: number;   // number of children in this fan-out
  first: boolean;  // index === 0
  last: boolean;   // index === total - 1
};
```

The order is a **documented guarantee**: host fan-out is ordered by agent id,
matrix fan-out by its combination label. So `ctx.fanout.first` is always the
same (lowest-agent-id) host across re-runs, and `ctx.fanout.last` the same final
one. `ctx.fanout` is `undefined` on a job that is not fanned out.

### Run-once steps: onlyOnFirstHost / onlyOnLastHost / onlyOnFanoutIndex

For ordered, stateful rollouts you often need a step that runs on exactly **one**
host — enable a leader before the rest join, run a one-time migration, take a
single dump. Three rule helpers express this by reading `ctx.fanout`:

```typescript
import { job, step, onlyOnFirstHost, onlyOnLastHost, onlyOnFanoutIndex } from '@kici-dev/sdk';

const rollout = job('rollout', {
  runsOnAll: 'role:db',
  maxParallel: 1, // serial, so "first" runs before the rest
  steps: [
    // Runs only on the first (lowest-agent-id) host — KiCI's run-once primitive.
    step('enable-sync-mode', { rules: [onlyOnFirstHost()] }, async (ctx) => {
      /* configure the leader before standbys join */
    }),
    // Runs on every host.
    step('apply', async (ctx) => {
      /* ... */
    }),
    // Runs only on the last host.
    step('finalize', { rules: [onlyOnLastHost()] }, async (ctx) => {
      /* ... */
    }),
  ],
});
```

- A step gated this way is **skipped** (not failed) on non-matching hosts — its
  outputs exist only on the host where it ran.
- `onlyOnFanoutIndex(n)` targets the host at a specific position.
- **Non-fan-out safety:** on a job that is not fanned out, `ctx.fanout` is
  `undefined` and these helpers treat the job as a single implicit child at
  index 0 — so `onlyOnFirstHost()` runs normally there (there is one host, which
  is the first). This means you can author a step with `onlyOnFirstHost()` and it
  behaves correctly whether or not the job ends up fanning out.
- The helpers are host-flavored by name (the dominant use case) but read
  `ctx.fanout`, so they work for matrix fan-out too — `onlyOnFirstHost()` runs on
  the first combination.

### byHost outputs

A downstream that `needs:` a `runsOnAll` job receives a **byHost** envelope instead
of a flat outputs object — keyed by hostname, with a per-host summary:

```typescript
import { isHostJobOutputs } from '@kici-dev/sdk';

const report = job('report', {
  runsOn: 'role:control',
  needs: [patch],
  run: async (ctx) => {
    const outputs = ctx.jobOutputs(patch);
    if (isHostJobOutputs(outputs)) {
      ctx.log.info(`succeeded: ${outputs.summary.succeededHosts.join(', ')}`);
      ctx.log.info(`failed: ${outputs.summary.failedHosts.join(', ')}`);
      // Per-host outputs, keyed by hostname:
      const version = outputs.byHost['web-01']?.version;
      // Array view of one output key across every host:
      const allVersions = outputs.summary.outputs.version;
    }
  },
});
```

Unlike the matrix envelope's last-write-wins `merged`, the host summary never collapses
to a single scalar: `summary.outputs[key]` is an array of every host's value, and
`succeededHosts` / `failedHosts` record each host's terminal outcome.

### onUnreachable: skip | fail | hold

Resolution is backed by the **declared host roster** (see the operator
[host roster](/operator/orchestrator/host-roster/) doc), not just the live registry.
This lets KiCI surface an expected-but-absent host instead of silently fanning out to a
partial fleet. The `onUnreachable` policy controls what happens when a **durable**
(static) host in the roster is matched but not currently connected:

- **`hold`** (default) — queue a pinned child for the absent host and wait for it to
  reconnect. The fan-out is honest: a 5-host fleet with 1 host rebooting reports
  `4 ran, 1 held`, not a silent 4-of-5 success.
- **`skip`** — omit the absent durable host and run only on the reachable hosts.
- **`fail`** — fail the run init if any expected durable host is unreachable.

```typescript
const patch = job('patch', {
  runsOnAll: 'role:web',
  onUnreachable: 'skip',
  run: async (ctx) => {
    /* ... */
  },
});
```

Ephemeral (scaled-down) hosts that are no longer connected are **always** skipped,
independent of `onUnreachable` — a scaled-down node may never return. A `runsOnAll`
that matches zero usable hosts fails the run rather than reporting a silent zero-child
success.

### includeUninitialized: converge a fresh fleet

`onUnreachable` governs declared hosts that _had_ an agent and are momentarily absent.
A **never-initialized** host — a freshly-provisioned box reachable over SSH but with no
agent yet — is a different case: there is nothing to run on. Set
`includeUninitialized: true` to widen the fan-out to those hosts and bring them up:

```typescript
const converge = job('converge', {
  runsOnAll: 'kici:group:prod',
  includeUninitialized: true,
  steps: [partitionDisk, formatLuks, debootstrap, installAgent],
});
```

For each un-agented declared host (one carrying SSH reach metadata), KiCI brings up a
temporary init-runner over SSH and runs the **same steps** on it; hosts that already
have a live agent run the steps on their own agent. One workflow converges the whole
fleet — fresh boxes get built, live boxes run the same phases.

Because the steps run on already-initialized hosts too, the bootstrap phases **must be
idempotent [check-steps](/user/sdk/core/)**: each step's `check()` reports in-sync on a
live box so the partition / format / install steps **skip** there and run only on fresh
boxes. This is the safety guard — an OS or disk-format step must never re-run on a host
that is already built. Re-running the workflow is a no-op everywhere. See the operator
[fresh-box bootstrap](/operator/orchestrator/host-roster/) doc for the bring-up,
capability gating, and lifecycle details.

`includeUninitialized` is only meaningful alongside `runsOnAll`; it is ignored on a
single-agent `runsOn` job.

### Rolling rollout: maxParallel + failFast

By default a `runsOnAll` fan-out dispatches to every matched host at once — fine for
collecting state across the fleet, dangerous for a deploy that takes the whole tier
down simultaneously. Two job options bound the rollout:

- **`maxParallel`** — the fan-out width: at most this many hosts run at once. It is a
  sliding window — each host that finishes (success or failure) releases the next held
  host. `maxParallel: 1` is a strictly serial, one-host-at-a-time rolling deploy. Must
  be `>= 1`.
- **`failFast`** — when `true`, the first host failure halts the rollout: no further
  held hosts are started, and the remaining ones are marked skipped. Default `false`
  (every host runs regardless of sibling outcomes — the same as the unbounded fan-out).

```typescript
const deploy = job('deploy', {
  runsOnAll: 'role:web',
  onUnreachable: 'skip', // see the caveat below
  maxParallel: 1, // strictly one host at a time
  failFast: true, // stop the roll on the first failure
  run: async (ctx) => {
    /* patch ctx.host */
  },
});
```

Both options are **fan-out-generic** — they bound a `matrix` fan-out exactly the same
way (the children are matrix combinations instead of hosts). They are ignored on a job
with neither `matrix` nor `runsOnAll` (there is no fan-out to bound).

**Caveat — use `onUnreachable: 'skip'` or `'fail'` for rolling deploys, not `'hold'`.**
A held host occupies a wave slot indefinitely while it waits to reconnect, stalling the
roll behind an absent box. `skip` (run only reachable hosts) or `fail` (refuse the roll
if any expected host is down) keep the window moving.

### Narrowing the roster at run time with `--target`

A `runsOnAll` predicate is authored once in the workflow, but you can narrow it for a
single run with `kici run --target <selector>` — an Ansible-`--limit`-style runtime
filter. The effective host set becomes `runsOnAll ∩ target`: the selector can only
_remove_ hosts from the matched roster, never add them. The narrowing is **run-global**
(it applies to every `runsOnAll` job) and **`runsOnAll`-only** (single `runsOn`-pinned
jobs are untouched). Repeated `--target` values AND-combine — a host must satisfy every
selector to survive.

```bash
# Patch only the role:web subset of whatever role:* hosts the job would match
kici run remote deploy --target role:web

# Intersect two selectors: hosts must be BOTH role:web AND dc:eu
kici run remote deploy --target role:web --target dc:eu
```

When `--target` narrows a `runsOnAll` job to zero hosts, the run **fails** by default
(a mistyped selector should be loud, not silently no-op). Pass `--target-allow-empty`
to **skip** the zeroed job instead — it records a `skipped` status, and downstream jobs
gated with `when: 'on-skip'` (or `when: 'always'`) still run, exactly as for an
`onUnreachable: 'skip'` zero-host fan-out. See the [CLI reference](/user/cli-reference/#host-narrowing-with---target)
for the full flag behavior and the [`needs` gating model](./core.md#job-dependencies-needs)
for how a skipped upstream propagates.

### Limits (v0)

- Per-host secret scoping is not yet available — all hosts receive the job's resolved
  secrets.
