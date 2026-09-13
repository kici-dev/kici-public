---
title: Data residency
description: 'Field-level reference of what data reaches the hosted KiCI Platform, what only transits it, and what never leaves your infrastructure'
---

The orchestrator and agents run in your infrastructure. In `platform`, `hybrid`,
and `observed` modes the orchestrator holds one outbound WebSocket connection to
the hosted Platform (`api.kici.dev`), and this page enumerates — field by field —
what travels over that connection. In `independent` mode the orchestrator makes
no connection to any KiCI-operated service, and nothing on this page is sent
anywhere.

`observed` mode narrows the surface further: the orchestrator sends everything in
the table below (so the hosted dashboard works in full), but **no webhook payload
ever reaches the Platform** — providers post straight to your orchestrator's own
public URL. See [Observed mode](#observed-mode-no-webhook-payload-transits-kici)
below.

## What reaches the hosted Platform (platform, hybrid, and observed modes)

Derived from the orchestrator-to-Platform protocol schema in the
`@kici-dev/engine` package (`packages/engine/src/protocol/messages/`); the
message types named below are the wire contract.

| Data                     | Examples                                                                                 | Stored by the Platform                 | Protocol message              |
| ------------------------ | ---------------------------------------------------------------------------------------- | -------------------------------------- | ----------------------------- |
| Run lifecycle metadata   | run id, workflow name, status, timestamps, durations, job count, re-run lineage          | Yes                                    | `execution.status`            |
| Repository identity      | `owner/repo`, provider, commit sha, ref, trigger event, first line of the commit message | Yes                                    | `execution.status`            |
| Trigger actor identity   | provider username and user id of the pusher / PR author                                  | Yes                                    | `execution.status`            |
| Job metadata             | job names, statuses, durations, error messages, agent labels, context names              | Yes                                    | `job.status.forward`          |
| Step metadata            | step names, statuses, and step-level error messages                                      | No — transit only (see below)          | `step.status.forward`         |
| Secret key names         | names of secrets a step accessed — never the values                                      | No — transit only (see below)          | `step.status.forward`         |
| Job context              | environment variable names (secret values masked), runtime and sandbox info, SDK version | Yes                                    | `job.context`                 |
| Run timeline and timings | clone/spawn/execution phase markers with durations                                       | Yes                                    | `run.event`                   |
| Log line content         | live log lines while a run streams                                                       | **No — transit only** (see below)      | `log.chunk`, `orch-log.chunk` |
| Operational metrics      | orchestrator telemetry counters and histograms                                           | Retained in the hosted metrics backend | `orch.metrics`                |

## What transits but is not stored

Some data reaches the Platform only as a live fan-out to your browser during an
active run — the Platform relays it in memory and never writes it to durable
storage. This covers three of the rows above: **log line content**, **step
metadata** (step names, statuses, and step-level errors), and the **secret key
names** a step accessed. The per-job **matrix values** (the matrix coordinates a
job ran with) are also fanned out live but not persisted. When a run is
streaming, the Platform forwards each of these straight to the dashboard and
drops it; nothing is persisted. For logs,
the only figures the Platform keeps are aggregate byte counts recorded as run
metadata. Both step logs and orchestration/provisioning logs stream the same way.

Historical log views in the hosted dashboard are served identically: they are
fetched from **your** orchestrator on demand and passed through the relay. Log
storage itself lives on your orchestrator's storage backend, never on the
Platform.

## What never leaves your infrastructure

- **Secret values** — masked before they leave the agent sandbox; only key names
  ever appear in run metadata.
- **Your source code and cloned repositories** — no protocol field carries file
  content.
- **Workflow file contents** — never transmitted.
- **Full log storage** — logs are written to your orchestrator's storage backend.
- **The database** — run history and configuration live in your PostgreSQL
  instance.

## Observed mode: no webhook payload transits KiCI

`KICI_MODE=observed` keeps the Platform connection for observability but removes
the relay leg entirely. Providers deliver webhooks directly to your
orchestrator's own public URL (`KICI_WEBHOOK_PUBLIC_URL`), so the raw webhook
body, its headers, and its signature never touch KiCI infrastructure — a
stronger residency posture than `hybrid`, without giving up the hosted
dashboard.

The guarantee is enforced on both sides: the Platform excludes an observed
orchestrator from every relay-candidate lookup, and the orchestrator refuses any
relayed webhook it somehow receives. Its sources are registered as
**observe-only** — visible in the dashboard Sources page and attributable to
runs, but never routed. GitHub-App sources are unsupported in this mode because
they are relay-ingested by construction; use a generic or local source.

Everything else on this page is unchanged: run, job, step, log, and event
metadata still stream to the hosted Platform exactly as in `hybrid`.

## Independent mode: nothing is sent

With `KICI_MODE=independent` there is no Platform connection at all. Webhooks
come straight from your git host to your orchestrator, and every field above
stays inside your network. See [Network requirements](./network-requirements.md)
for the connection details.

## See also

- [Is self-hosting the agents a security risk?](./security/self-hosting-security.md) — the containment model for self-hosted agents.
- [Network requirements](./network-requirements.md) — outbound allowlist and inbound surface.
- [Protocol overview](../architecture/protocol/overview.md) — the orchestrator-to-Platform message protocol.
