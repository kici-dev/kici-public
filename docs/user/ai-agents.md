---
title: Drive KiCI from your coding agent
description: Point a coding agent at KiCI's MCP server and let it trigger, read, and re-run your CI under your own identity.
---

KiCI ships a hosted **MCP server** so a coding agent (Claude Code, or any MCP
client) can drive your CI directly: trigger runs, read a structured result,
fetch the failing step's logs, cancel, and re-run — all under your own identity,
org-scoped, and audited. There are no per-tool tokens to configure: point the
agent at one URL with one credential and it's done.

The MCP exposes only what you can already do yourself through the `kici` CLI and
the dashboard. It is not a new privileged surface — every tool maps to an
existing user-facing operation and is gated by the same permissions your role
grants.

## 1. Mint an agent token

The MCP accepts **only** an agent-kind personal access token (PAT). Mint one with
the `kici` CLI (log in first with `kici login`):

```bash
kici pat create --agent --name "claude-code"
```

The `--name` value is the **agent label**. It is recorded on every action the
agent takes, so your audit log shows exactly which agent did what (and on whose
behalf). The token is printed once — save it now; it cannot be retrieved later.

An agent PAT inherits your permissions unchanged — it carries provenance, not
extra authority. Powerful operator capabilities (secret rotation, agent and peer
management, draining) are intentionally **not** exposed here.

## 2. Point your coding agent at the MCP server

Configure your MCP client with the KiCI MCP endpoint and the agent PAT as a
Bearer credential. The endpoint is the hosted Platform URL plus `/api/v1/mcp`.

For Claude Code, add a remote MCP server whose URL is your KiCI Platform's
`/api/v1/mcp` and whose `Authorization` header is `Bearer <your-agent-pat>`.

That's the entire setup. The agent can now call the tools below.

## 3. What the agent can do

**Read**

- `list_runs` — recent runs in your organization.
- `get_run` — the structured, provenance-tagged result of a run: the typed job
  graph, per-step statuses and exit codes, durations, and a derived failure
  category.
- `get_step_logs` — the log lines for a specific step.
- `list_workflows` — your registered workflows.

**Drive**

- `trigger_run` — run a registered workflow ("run now").
- `rerun_run` — re-run a completed run.
- `cancel_run` — cancel an in-progress run.

If you belong to a single organization, the org is resolved automatically. If
you belong to several, pass an `orgId` argument to any tool.

## 4. Why the structured result is agent-safe

`get_run` and `get_step_logs` return a machine-first shape designed for an agent
to reason over without being misled by repository content. Every field that
comes from your repo, a contributor, or a process's output — workflow and job
names, refs, error messages, log lines, job outputs — is wrapped in an
`{ untrusted: true, value: … }` envelope. KiCI-generated values (ids, statuses,
exit codes, durations, the derived failure category) are left plain. An agent can
keep user-controlled content out of its instruction channel by refusing to act
on anything tagged `untrusted`.

Secret values are never returned — only the names of the secret keys a step
accessed.

## 5. The audit guarantee

Because the MCP accepts only an agent-kind PAT, **every action that flows through
it is agent-attributed by construction** — there is no path that produces an
untagged, human-looking action. Each read and each drive operation is recorded in
your orchestrator's access log under your identity plus the agent label, so you
always have a complete trail of what your agent did.

Inspect that trail with `kici-admin access-log list --json` (or
`kici-admin access-log show <id>` for one entry). An agent-attributed row keeps
`actor_type` as `user` and `actor_id` as your own identity — the agent provenance
rides in the row's actor metadata as `agentLabel` (the `--name` you minted the
PAT with) and `agentPatId` (the token that acted). The label is also stored in a
dedicated `agent_label` column on every such row.
