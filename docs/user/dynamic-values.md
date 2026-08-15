---
title: Dynamic values
description: Compute a job's context, env, and concurrencyGroup at runtime from the incoming event
---

Dynamic values let you compute `context`, `env`, and `concurrencyGroup` at runtime based on the incoming event. Instead of hardcoding static strings, you pass a function that receives the normalized event envelope and returns the resolved value.

```typescript
job('deploy', {
  runsOn: ['default'],
  context: (event) => event.targetBranch,
  env: (event) => ({ BRANCH: event.targetBranch }),
  concurrencyGroup: (event) => `deploy-${event.targetBranch}`,
  steps: [/* ... */],
});
```

```typescript
job('deploy', {
  runsOn: 'default',
  // One shape everywhere: branch on the normalized event type.
  context: (event) => (event.type === 'pull_request' ? 'preview' : 'production'),
  steps: [/* ... */],
});
```

## How it works

When you define a dynamic value as a function, it is resolved on the eval agent as a short **init** step that runs before the job:

1. The orchestrator dispatches a lightweight `__init__` job to an agent.
2. The agent loads the compiled workflow bundle and calls your function with the normalized event.
3. The agent reports the resolved values back to the orchestrator, which dispatches the real execution job with them applied.

This resolution appears in the run timeline as an `Init:` entry. The orchestrator never evaluates workflow code — every dynamic `context`, `env`, and `concurrencyGroup` function runs agent-side, whatever it references.

`kici preview` lists the injected `__init__` job under each affected job, so you can spot it before the first run.

**Examples:**

```typescript
// Simple branch extraction
context: (event) => event.targetBranch;

// Object literal with string operations
env: (event) => ({ BRANCH: event.targetBranch });

// Concatenation with event data
concurrencyGroup: (event) => `deploy-${event.targetBranch}`;

// Local variables and safe globals
context: (event) => {
  const parts = event.targetBranch.split('/');
  return parts[parts.length - 1];
};

// Async lookups, module access, and process/global reads all work
context: async (event) => await lookupEnv(event.targetBranch);
env: (event) => ({ DEFAULT_ENV: process.env.DEFAULT_ENV ?? 'staging' });
```

## Performance

| Value                    | Overhead  | Example                                  |
| ------------------------ | --------- | ---------------------------------------- |
| Static value             | None      | `context: 'staging'`                     |
| Dynamic value (function) | Init step | `context: (event) => event.targetBranch` |

A static value is baked into the lock file and needs no init step. A dynamic value always resolves through the agent's init step, so reach for a function only when the value genuinely depends on the event.

## Tips

- **Prefer static values when you can.** Most context and env values are the same on every event; only make them dynamic when they truly depend on the event payload.
- **Run `kici preview`** to see the injected `__init__` job listed under each affected job before your first run.
- **A runtime error in a dynamic function fails the job.** If your function throws when the init step runs it (e.g., accessing a property on `undefined`), the job fails immediately.
- **See [how your workflow code executes](./execution-model.md)** for the full picture of where dynamic values run relative to rules, hooks, and step bodies.
- **The event parameter is the normalized event envelope** — the same shape rules receive as `ctx.event`: `{ type, action, targetBranch, sourceBranch, changedFiles, payload, … }` (see the [event payload reference](./sdk/event-payloads.md) for the complete schema). Narrow on `event.type` (`'push'`, `'pull_request'`, `'tag'`, …) to branch per trigger kind. The raw provider webhook body is nested at `event.payload` (for GitHub pushes: `payload.ref`, `payload.after`, `payload.repository`, …).
