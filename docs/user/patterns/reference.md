---
title: Pattern reference
description: Step context, examples repository, GitHub check run output — cross-cutting reference for all patterns
---

Every step receives a `StepContext` with these properties:

| Property            | Type                                | Description                                                      |
| ------------------- | ----------------------------------- | ---------------------------------------------------------------- |
| `$`                 | zx shell                            | Shell executor for running commands                              |
| `log`               | `Logger`                            | Structured logger (info, warn, error, debug)                     |
| `env`               | `Record<string, string\|undefined>` | Environment variables                                            |
| `setEnv()`          | `(key, value) => void`              | Set an env var visible to this step and all subsequent steps     |
| `addPath()`         | `(dir) => void`                     | Prepend a directory to PATH for this and all subsequent steps    |
| `inputs`            | `Record<string, unknown>`           | Typed inputs from dependency outputs                             |
| `workflow`          | `{ name: string }`                  | Current workflow metadata                                        |
| `job`               | `{ name: string, runsOn: string }`  | Current job metadata                                             |
| `matrix`            | `MatrixValues \| undefined`         | Matrix values for current job instance                           |
| `setSecretOutput()` | `(key, value) => void`              | Publish an encrypted secret output consumable by downstream jobs |

### Step outputs

Steps can declare typed outputs using Zod schemas:

```typescript
import { step } from '@kici-dev/sdk';
import { z } from 'zod';

const build = step('build', {
  outputs: {
    version: z.string(),
    artifacts: z.array(z.string()),
  },
  run: async ({ $ }) => {
    await $`pnpm build`;
    return {
      version: '1.0.0',
      artifacts: ['dist/main.js', 'dist/styles.css'],
    };
  },
});
```

## Examples repository

For more runnable examples, see the [examples/](https://github.com/kici-dev/kici-public/tree/main/examples) directory in the KiCI repository.

## GitHub check run output

When workflows run via GitHub pull requests or pushes, KiCI creates GitHub Check runs that show detailed execution feedback directly in the GitHub UI.

### What you see

- **Live progress:** As steps execute, the check run updates with a checklist showing which steps are running, completed, or pending
- **Step durations:** Each step shows its execution time (e.g., "Install deps (1.2s)")
- **Failure details:** When a step fails, the check run includes the error message, exit code, and the last 20 lines of log output
- **Source annotations:** Failed steps are annotated directly on your workflow file (`.kici/workflows/*.ts`) in the GitHub PR diff, linking the failure to the exact `step()` call that failed

### Source location annotations

KiCI captures the source location of each `step()` call during compilation and stores it in the lock file. When a step fails, GitHub displays an annotation on the corresponding line in your workflow file:

```typescript
// This step's source location is captured automatically
step('run tests', async ({ $ }) => {
  await $`pnpm test`; // If this fails, GitHub annotates this step() call
});
```

To enable source location annotations, recompile your workflows after updating KiCI. The compiler captures step locations starting from compile schema version 2.

```bash
pnpm kici compile  # Regenerates kici.lock.json with source locations
```

## See also
