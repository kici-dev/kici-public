---
title: Agent run-result API
description: Machine-first, provenance-tagged read endpoints for run state and step logs.
---

The orchestrator exposes a machine-first read surface for run state, designed so an
automation agent can understand a run as **structure** — a typed job DAG with per-step exit
codes, durations, statuses, and a derived failure classification — instead of scraping
stderr. Every field that originates from outside KiCI is tagged so a consumer can keep
user-controlled content out of an agent's instruction channel.

These endpoints live on the orchestrator admin HTTP API and reuse its authentication: a
Bearer token validated against the orchestrator, the `run.read` RBAC permission, and
routing-key confinement (a routing-key-scoped token can only read runs under its own
routing key). They are read-only.

## Provenance tagging

Each field is either **trusted** or **untrusted**:

- **Trusted (plain value):** values KiCI itself generates or measures — run / job / step
  ids, enum statuses, exit codes, durations, timestamps, commit hashes, the derived
  failure category, the step type, the check outcome.
- **Untrusted (enveloped):** values sourced from the user's repository, the contributor,
  or a process's output — workflow / repository / job / step names, the git ref, the
  contributor username, error messages, job output values, and **every log line**. Each is
  wrapped:

  ```json
  { "untrusted": true, "value": "deploy to production" }
  ```

The envelope self-describes, so the tag survives reshaping. A consumer that fences
untrusted content simply refuses to render any `{ "untrusted": true }` value into an
instruction channel, while still showing it as data.

## Endpoints

### Structured run result

```
GET /api/v1/admin/runs/:runId/structured
```

Returns the run header plus the full job DAG. Trusted fields are plain; untrusted fields
are enveloped. Shape (abridged):

```json
{
  "runId": "run_123",
  "workflowName": { "untrusted": true, "value": "ci" },
  "status": "failed",
  "provider": "github",
  "repoIdentifier": { "untrusted": true, "value": "owner/repo" },
  "ref": { "untrusted": true, "value": "refs/heads/main" },
  "sha": "abc123",
  "baseSha": null,
  "startedAt": "2026-06-27T00:00:00.000Z",
  "completedAt": "2026-06-27T00:01:00.000Z",
  "durationMs": 60000,
  "trustTier": "trusted",
  "contributorUsername": { "untrusted": true, "value": "alice" },
  "failureCategory": "step_failed",
  "failureReason": { "untrusted": true, "value": "tests failed" },
  "triggeredBy": null,
  "jobs": [
    {
      "jobId": "job_1",
      "jobName": { "untrusted": true, "value": "build" },
      "status": "failed",
      "durationMs": 42000,
      "agentId": "agent-7",
      "errorMessage": { "untrusted": true, "value": "step 'test' failed" },
      "initFailure": null,
      "needs": [{ "ref": { "untrusted": true, "value": "lint" }, "runOn": ["success"] }],
      "outputs": { "build.url": { "untrusted": true, "value": "https://..." } },
      "secretOutputKeys": ["DEPLOY_TOKEN"],
      "steps": [
        {
          "stepIndex": 0,
          "stepName": { "untrusted": true, "value": "test" },
          "status": "failed",
          "exitCode": 1,
          "durationMs": 12000,
          "stepType": "step",
          "checkOutcome": null,
          "secretsAccessed": ["DEPLOY_TOKEN"]
        }
      ]
    }
  ]
}
```

`baseSha` is best-effort from the run's provider context; it is `null` when the base commit
is not available. `triggeredBy` is the identity that triggered a re-run, and `null` for
webhook-triggered runs.

### Step logs

```
GET /api/v1/admin/runs/:runId/jobs/:jobId/steps/:stepIndex/logs?cursor=&limit=
```

Returns a page of a step's log lines, **every line enveloped untrusted** (log output is
user/process-controlled). Pagination is line-based: `cursor` is a line offset, `limit`
defaults to 500 and is capped at 2000. `nextCursor` is the offset to fetch the next page,
or `null` when the last line has been returned.

```json
{
  "runId": "run_123",
  "jobId": "job_1",
  "stepIndex": 0,
  "totalLines": 1200,
  "lines": [{ "untrusted": true, "value": "Running tests..." }],
  "nextCursor": "500"
}
```

## Derived failure category

`failureCategory` is a trusted, coarse classification derived from data KiCI already
records (no heuristics). It is `null` for a run that did not fail, and otherwise one of:

| Category       | When                                                                 |
| -------------- | -------------------------------------------------------------------- |
| `init_failure` | The run/job recorded an init-phase failure (e.g. secret resolution). |
| `infra`        | The init failure was an infrastructure cause (no agent available).   |
| `timed_out`    | A job hit a configured wall-clock timeout.                            |
| `cancelled`    | The run was cancelled.                                               |
| `step_failed`  | A step exited non-zero.                                              |
| `unknown`      | The run failed with no clearer signal.                              |

## Secret safety

Secret output **values are never returned** by these endpoints. A job's non-secret outputs
appear as enveloped values under `outputs`; secret outputs appear only as key names under
`secretOutputKeys`, and `secretsAccessed` lists key names a step touched. Recovering a
secret value is a separate, audited break-glass path (`runs secret-outputs --reveal`).

## See also

- [kici-admin CLI](./kici-admin-cli.md) — `kici-admin runs structured <runId> [--json]` wraps
  the structured endpoint.
