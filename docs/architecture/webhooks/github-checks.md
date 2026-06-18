---
title: GitHub checks architecture
description: ''
---

**Module:** `packages/orchestrator/src/reporting/`

This document describes the enriched GitHub Check run system that provides real-time step progress, failure details with log context, and source location annotations.

## Overview

KiCI creates GitHub Check runs at trigger match time and updates them throughout job execution. Each workflow gets two types of check runs:

- **Workflow check run** (`kici/{workflowName}`) -- overall pass/fail for the workflow
- **Job check runs** (`kici/{workflowName}/job/{jobName}`) -- per-job detail with step progress
- **Build check run** (`kici/{workflowName}/setup`) -- optional, for dependency installation and compilation

## Data flow

```
Agent                          Orchestrator                      GitHub Checks API
  |                               |                                    |
  |--- step.status (running) ---->|                                    |
  |                               |--- updateStepProgress() --------->|
  |                               |    (immediate in_progress)        |
  |                               |                                    |
  |--- log.chunk (lines) -------->|                                    |
  |                               |--- stepLogBuffer.addLines() ----->|
  |                               |    (ANSI stripped, last 20)       |
  |                               |                                    |
  |--- step.status (success) ---->|                                    |
  |                               |--- updateStepProgress() --------->|
  |                               |    (debounced 5s)                 |
  |                               |                                    |
  |--- step.status (failed) ----->|                                    |
  |                               |--- updateStepProgress() --------->|
  |                               |    (debounced 5s)                 |
  |                               |                                    |
  |--- job.status (failed) ------>|                                    |
  |                               |--- updateJobStatus() ----------->|
  |                               |    cancel debounce timer          |
  |                               |    buildCheckRunSummary()          |
  |                               |    buildAnnotations()              |
  |                               |    (completed, failure)           |
```

## Components

### StepLogBuffer (`step-log-buffer.ts`)

Per-step ring buffer that retains the last 20 ANSI-stripped log lines for each step. Lines are keyed by `{runId}:{jobId}:{stepIndex}` composite key. Used by the summary builder to include log context in failure details.

- **Input:** `addLines(key, rawLines)` -- strips ANSI codes, evicts oldest lines when buffer exceeds 20
- **Output:** `getLastLines(key)` -- returns `{ lines, totalCount }` for truncation indicators
- **Cleanup:** `cleanup(runId)` -- removes all entries for a completed run

### CheckRunReporter (`check-run-reporter.ts`)

Central coordinator for all GitHub Checks API interactions. Manages:

- **Check run creation** (queued) at trigger match time
- **Live step progress** (in_progress) during execution with debouncing
- **Completion updates** (completed) with enriched summaries and annotations
- **Cleanup** of in-memory state when runs are pruned

Key methods:

| Method                   | When Called                | GitHub Status  |
| ------------------------ | -------------------------- | -------------- |
| `setPending()`           | Trigger match              | `queued`       |
| `updateStepProgress()`   | Step starts/completes      | `in_progress`  |
| `updateJobStatus()`      | Job reaches terminal state | `completed`    |
| `updateWorkflowStatus()` | All jobs complete          | `completed`    |
| `cleanupRun()`           | Run pruned from memory     | (cleanup only) |

### Summary/annotation builders (`check-run-summary.ts`)

Pure functions with no side effects:

- **`buildCheckRunSummary()`** -- Produces markdown with step table, failure details, log context, and trace footer. Uses progressive truncation (20 -> 10 -> 5 -> 0 log lines) to stay under the 65535 byte GitHub API limit.

- **`buildAnnotations()`** -- Creates GitHub-compatible annotation objects linking failures to source locations in `.kici/workflows/*.ts`. Capped at 50 per API request.

- **`buildProgressText()`** -- Produces checklist-style live progress with emoji prefixes for running/completed/pending states.

### SourceLocationStore (`app.ts`)

In-memory cache mapping `workflowName:jobName` to source location arrays (file, line, column). Populated during webhook processing when lock files contain `sourceLocation` data on steps. Used by `CheckRunReporter` to generate annotations.

## Debounce strategy

Live step progress updates are debounced to prevent GitHub API rate limiting:

1. **First `running` step:** Immediate `in_progress` update (transitions check run from `queued`)
2. **Subsequent updates:** Scheduled with 5-second debounce timer. If a timer is already pending, no new timer is created -- the pending timer picks up the latest state when it fires.
3. **Completion:** Cancels any pending debounce timer immediately. Completion always takes priority over progress updates to prevent race conditions.

This results in a maximum of 1 API call per 5 seconds per job check run during execution, plus the initial transition and final completion.

## Source location flow

Step source locations enable GitHub Check annotations that link failures directly to the `step()` call in the workflow source file (`.kici/workflows/*.ts`):

1. **SDK:** `step()` factory captures call-site file, line, and column via `Error.captureStackTrace`
2. **Compiler:** Writes `sourceLocation` to lock file `LockStep` with git-root-relative paths
3. **Orchestrator:** Extracts source locations from lock file during webhook processing, stores in `SourceLocationStore`
4. **Annotations:** On job failure, `buildAnnotations()` creates annotation objects with file paths and line numbers

Users must recompile their workflows (schema version 2+) to get source location data in their lock files.

## Details URL contract

Every check run carries a `details_url` pointing at a dashboard route the reader can click straight from the GitHub UI. The URL uses an opaque public alias for the org, not the canonical internal org identifier:

```
https://<dashboard-host>/r/orgs/oal_<12-char>/runs/<run-uuid>
```

- `oal_<12-char>` is a server-generated random alias (16 chars total, ~71 bits of entropy) stored alongside every org. It is **never** derived from the org's display name, and **never** the same string as the canonical org ID, which carries a different `org_` prefix and is only used inside the authenticated system.
- The `/r/orgs/:alias/*` resolver authenticates the visitor, verifies org membership, and redirects to the canonical dashboard run-detail page. Unauthenticated visitors hit the OIDC login flow and land at the run detail after sign-in. Unknown aliases and non-members get the same uniform 404 — the resolver does not double as an org existence oracle.
- The orchestrator caches its org's public alias on connect and emits the alias-bearing `details_url` on every `checks.create()` and `checks.update()`. If the orchestrator was deployed without a dashboard URL configured (independent mode without operator config), `details_url` is omitted and the GitHub check still works without a "Details" link.

The split means a public repository can host a KiCI workflow without leaking the org's canonical identifier to anyone reading the repo's check runs.

## Summary format

### Failed job

```markdown
**Job 'ci/test' failed** (2/3 steps passed)

| Step         | Status            | Duration |
| ------------ | ----------------- | -------- |
| Install deps | checkmark success | 1.2s     |
| Build        | checkmark success | 3.4s     |
| Run tests    | cross failed      | 5.6s     |

### cross Run tests

**Error:** Process exited with code 1

... (showing last 20 of 142 lines)
\`\`\`
FAIL src/auth.test.ts
Expected: true
Received: false
\`\`\`

Exit code: 1

Trace: abc-123 | Run: def-456
```

### Successful job

```markdown
**Job 'ci/test' passed** (3/3 steps passed)

| Step         | Status            | Duration |
| ------------ | ----------------- | -------- |
| Install deps | checkmark success | 1.2s     |
| Build        | checkmark success | 3.4s     |
| Run tests    | checkmark success | 5.6s     |

**Total duration:** 10.2s

Trace: abc-123 | Run: def-456
```

### Live progress (in_progress)

```
checkmark Install deps (1.2s)
checkmark Build (3.4s)
hourglass Run tests...
circle Deploy

Trace: abc-123 | Run: def-456
```

## Size limits

- **Summary:** 65535 bytes (GitHub API limit). Progressive truncation ensures compliance.
- **Annotations:** 50 per API request. If more annotations exist, the remaining count is mentioned in the summary.

## Cleanup

When the `ExecutionTracker` prunes a completed run from memory (after 5 minutes), the `onRunPruned` callback triggers:

1. `StepLogBuffer.cleanup(runId)` -- removes all log entries for the run
2. `CheckRunReporter.cleanupRun(runId)` -- removes step progress entries and cancels pending debounce timers

This prevents memory leaks from accumulating log lines and progress state for completed runs.
