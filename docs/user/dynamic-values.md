---
title: Dynamic values
description: ''
---

Dynamic values let you compute `environment`, `env`, and `concurrencyGroup` at runtime based on the incoming event. Instead of hardcoding static strings, you pass a function that receives the normalized event envelope and returns the resolved value.

```typescript
job('deploy', {
  runsOn: ['default'],
  environment: (event) => event.targetBranch,
  env: (event) => ({ BRANCH: event.targetBranch }),
  concurrencyGroup: (event) => `deploy-${event.targetBranch}`,
  steps: [
    /* ... */
  ],
});
```

```typescript
job('deploy', {
  runsOn: 'default',
  // One shape everywhere: branch on the normalized event type.
  environment: (event) => (event.type === 'pull_request' ? 'preview' : 'production'),
  steps: [
    /* ... */
  ],
});
```

## How it works

When you define a dynamic value as a function, the compiler analyzes it at compile time to determine whether it is **pure** (can be evaluated without cloning the repo or running an init job).

### Pure functions (inline evaluation)

A pure function is one that:

- Is synchronous (no `async`/`await`)
- Only references its parameters and local variables
- Does not import or require external modules
- Does not access globals like `process`, `fetch`, `console`, `setTimeout`, etc.
- Uses only safe built-in constructors: `String`, `Number`, `Boolean`, `Array`, `Object`, `JSON`, `Math`, `parseInt`, `parseFloat`, `isNaN`, `isFinite`, `encodeURIComponent`, `decodeURIComponent`, `encodeURI`, `decodeURI`
- Does not use `this`, `new`, `class`, `throw`, `try`/`catch`, `delete`, `var`, `yield`, or mutation operators (`++`, `--`, `+=`, etc.)

When the compiler detects a pure function, it serializes the function source directly into the lock file as an inline expression. At dispatch time, the orchestrator evaluates the expression in a sandboxed VM context (~0ms overhead) instead of dispatching an init job.

**Examples of pure functions:**

```typescript
// Simple branch extraction
environment: (event) => event.targetBranch;

// Object literal with string operations
env: (event) => ({ BRANCH: event.targetBranch });

// Concatenation with event data
concurrencyGroup: (event) => `deploy-${event.targetBranch}`;

// Using safe globals
env: (event) => ({ UPPER: String(event.targetBranch).toUpperCase() });

// Local variables are fine
environment: (event) => {
  const parts = event.targetBranch.split('/');
  return parts[parts.length - 1];
};
```

### Impure functions (init-job evaluation)

If the compiler determines a function is impure, it emits a warning during compilation and falls back to the two-phase init model. This means:

1. The orchestrator dispatches a special `__init__` job to a builder agent
2. The builder agent clones the repository and evaluates the function
3. The resolved values are sent back to the orchestrator
4. The orchestrator dispatches the real execution job with the resolved values

This adds approximately 5-10 seconds of overhead for cloning and evaluation.

**Examples of impure functions (will use init job):**

```typescript
// Async functions cannot be inlined
environment: async (event) => await lookupEnv(event.targetBranch);

// External module references
env: (event) => {
  const config = require('./config');
  return config.env;
};

// Process/global access
environment: (event) => process.env.DEFAULT_ENV || 'staging';

// Dynamic imports
env: async (event) => {
  const m = await import('./config.js');
  return m.default;
};
```

## Performance comparison

| Evaluation path                      | Overhead | When used                                                           |
| ------------------------------------ | -------- | ------------------------------------------------------------------- |
| Static value (string/object literal) | ~0ms     | `environment: 'staging'`                                            |
| Inline expression (pure function)    | ~0ms     | `environment: (event) => event.targetBranch`                        |
| Init job (impure function)           | ~5-10s   | `environment: async (event) => await lookupEnv(event.targetBranch)` |

## Tips

- **Write pure functions whenever possible** to avoid the init-job delay. Most environment and env computations only need the event payload data.
- **Check compiler warnings** -- the compiler tells you when a function is classified as impure and explains why.
- **Runtime errors in inline expressions cause immediate job failure.** There is no fallback to the init-job path. If your pure function throws at runtime (e.g., accessing a property on `undefined`), the job fails immediately.
- **The event parameter is the normalized event envelope** — the same shape rules receive as `ctx.event`: `{ type, action, targetBranch, sourceBranch, changedFiles, payload, … }` (see the [event payload reference](./sdk/event-payloads.md) for the complete schema). Narrow on `event.type` (`'push'`, `'pull_request'`, `'tag'`, …) to branch per trigger kind. The raw provider webhook body is nested at `event.payload` (for GitHub pushes: `payload.ref`, `payload.after`, `payload.repository`, …).
