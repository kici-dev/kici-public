---
title: Drive KiCI from your coding agent
description: Point a coding agent at KiCI's MCP server and let it trigger, read, and re-run your CI under your own identity.
---

KiCI ships a hosted **MCP server** so a coding agent (Claude Code, or any MCP
client) can drive your CI directly: trigger runs, read a structured result,
fetch the failing step's logs, cancel, and re-run — all under an agent identity
you control, org-scoped, and audited. There are no per-tool tokens to configure:
point the agent at one URL with one credential and it's done.

The MCP exposes only what you can already do yourself through the `kici` CLI and
the dashboard. It is not a new privileged surface — every tool maps to an
existing user-facing operation and is gated by the same permissions your role
grants.

## 1. Mint an agent credential

The MCP accepts an **agent-kind credential** — and only an agent-kind one. It
can be either of two kinds:

- An **agent personal access token (PAT)** that you own — it acts as you, with
  your provenance. The token is `kici_pat_…`.
- An **agent org API key** that belongs to your organization — a
  provenance-carrying service account, independent of any one person. The key is
  `kici_sk_…`.

Both drive the MCP identically. A non-agent token of either kind (a plain user
PAT, a plain org API key) is refused at the door.

**Option A — an agent PAT.** Mint one with the `kici` CLI (log in first with
`kici login`):

```bash
kici pat create --agent --name "claude-code"
```

The `--name` value is the **agent label**. It is recorded on every action the
agent takes, so your audit log shows exactly which agent did what (and on whose
behalf). The token is printed once — save it now; it cannot be retrieved later.

**Option B — an agent org API key.** Create one from the dashboard's
**Settings → API keys** tab: set the key's kind to **Agent** and give it an
agent name (the agent label). The same key can also be minted with
`kici-platform-admin user api-key create --org <id> --agent --agent-label <label>`.
Reach for an org agent key when the agent should act as a shared service account
rather than as a single user — for example, a long-lived CI bot that outlives any
individual's membership.

Whichever you pick, the credential carries provenance, not extra authority. Its
effective permissions are the matrix it was minted with, and that matrix can
never exceed the permissions of the person who created it — so you can scope an
agent credential **below** your own access (for example, read-only) and the agent
is held to that smaller set. Powerful operator capabilities (secret rotation,
agent and peer management, draining) are intentionally **not** exposed here. See
[the agent safety model](#6-the-agent-safety-model) for how scoping and
confinement work.

## 2. Point your coding agent at the MCP server

KiCI's hosted MCP server lives at one fixed URL:

```
https://api.kici.dev/api/v1/mcp
```

Configure your MCP client with that URL and your agent credential (the agent PAT
or the agent org key) as a Bearer credential. For Claude Code:

```bash
claude mcp add --transport http kici https://api.kici.dev/api/v1/mcp \
  --header "Authorization: Bearer <your-agent-credential>"
```

That's the entire setup. The agent can now call the tools below.

## 3. What the agent can do

**Read**

- `list_runs` — recent runs in your organization.
- `get_run` — the structured, provenance-tagged result of a run: the typed job
  graph, per-step statuses and exit codes, durations, and a derived failure
  category.
- `get_step_logs` — the log lines for a specific step.
- `list_workflows` — your registered workflows, optionally filtered by
  `triggerType`, `repo`, or `stale` (only those not triggered within a duration
  like `30d`).
- `list_orgs` — the organizations you belong to. Use it to discover the `orgId`
  to pass to the other tools when you're a member of more than one.
- `list_secrets` — the secret scopes in your organization and the **key names**
  each holds. Secret values are never returned — only the names.
- `list_orchestrators` — the connected orchestrator clusters your runs execute
  on (cluster name, routing keys, version, scaler backends, health).
- `get_diagnostics` — your organization's execution metrics over the last 24
  hours (run count, success rate, average duration, queued and running jobs)
  plus per-orchestrator connection health.

**Drive**

- `trigger_run` — run a registered workflow ("run now").
- `rerun_run` — re-run a completed run.
- `cancel_run` — cancel an in-progress run.
- `approve_run` — approve a held approval gate for a run (name the run, plus
  `job`/`step` to disambiguate when it has multiple holds).
- `reject_run` — reject a held approval gate; a `reason` is required.
- `cancel_runs_by_branch` — cancel all in-progress runs on a branch (bounded —
  up to 100 per call; a `truncated` flag tells the agent to re-invoke).

The tools cover the same developer operations you can drive yourself with the
`kici` CLI. Operations that are purely local to your machine (scaffolding,
compiling, running a workflow locally) or that mint credentials are
intentionally not exposed — the agent works against your deployed CI, not your
filesystem.

If you belong to a single organization, the org is resolved automatically. If
you belong to several, pass an `orgId` argument to any tool (use `list_orgs` to
find it).

### Limits and pagination

The MCP server applies a few bounds so an agent loop can't overwhelm the shared
infrastructure. They are agent-visible — your agent gets a clear tool error and
should back off or page, never a silent truncation:

- **Per-token request limits.** Each agent token has its own ceiling, refreshed
  every minute: **120 reads/minute** (listing and fetching runs, step logs, and
  workflows) and **20 run actions/minute** (cancel, re-run, trigger, approve,
  reject, cancel-by-branch). The two
  budgets are independent. An over-limit call returns a tool error telling the
  agent which kind of operation was throttled and how many seconds to wait
  before retrying.
- **Paginated step logs.** `get_step_logs` returns log lines in pages. Pass a
  `limit` to bound a page (capped server-side) and follow the returned
  `nextCursor` (as `cursor` on the next call) to read more. A large step log is
  paged, never silently cut off — when `nextCursor` is null you've reached the
  end.
- **Bounded run results.** `get_run` returns the structured run result, which is
  naturally bounded by workflow size. For a pathologically large run it returns a
  tool error directing the agent to inspect specific steps with `get_step_logs`
  instead.

## 4. Why the structured result is agent-safe

Every tool returns a machine-first shape designed for an agent to reason over
without being misled by repository content. Each field that comes from your repo,
a contributor, or a process's output — workflow and job names, refs, error
messages, log lines, job outputs — is delivered **fenced** as untrusted data:
wrapped in a per-response, randomly-named delimiter (`⟦u:<nonce>⟧…⟦/u:<nonce>⟧`),
with the result prefixed by a notice that fenced text is data, never instructions.
KiCI-generated values (ids, statuses, exit codes, durations, the derived failure
category) are left plain. So an agent can keep user-controlled content out of its
instruction channel by treating anything inside a fence as data only. See
[Untrusted content and prompt injection](#7-untrusted-content-and-prompt-injection)
for the full model.

Secret values are never returned — only the names of the secret keys a step
accessed.

## 5. The audit guarantee

Because the MCP accepts only an agent-kind credential, **every action that flows
through it is agent-attributed by construction** — there is no path that produces
an untagged, human-looking action. Each read and each drive operation is recorded
in your orchestrator's access log under the acting identity plus the agent label,
so you always have a complete trail of what your agent did.

Inspect that trail with `kici-admin access-log list --json` (or
`kici-admin access-log show <id>` for one entry). The acting identity depends on
which credential you used:

- An **agent PAT** keeps `actor_type` as `user` and `actor_id` as your own
  identity — the agent provenance rides in the actor metadata as `agentLabel`
  (the `--name` you minted the PAT with) and `agentPatId`.
- An **agent org key** keeps `actor_type` as `api_key` and `actor_id` as the key
  — the same `agentLabel` provenance rides in its actor metadata.

Either way the label is stored in a dedicated `agent_label` column on every such
row, so you can filter the access log down to just agent activity:

```bash
# Every action a specific agent took, by its label:
kici-admin access-log list --agent-label "claude-code"

# Every agent-attributed action, across all agents:
kici-admin access-log list --agent-only
```

In the dashboard, agent-driven activity is visually distinguished: the
[Activity](./dashboard/activity-and-dlq.md#activity) log renders an **agent badge**
on every agent-attributed row, and a run's **Triggered by** shows the same badge
when an agent triggered or cancelled it — so an agent's footprint is obvious at a
glance, not buried in metadata.

## 6. The agent safety model

KiCI treats a coding agent as a **least-privilege principal with its own token**,
not as an unscoped extension of you. Three properties make the agent
"confined and audited by construction":

**Least-privilege, capped at the creator.** An agent token is scoped when you
mint it. Leave the scope open and it inherits your role; narrow it and the agent
is held to that smaller set — its effective permissions are always the
**minimum** of your role and the token's scope. A token can never grant more than
you hold, so an agent cannot escalate beyond its creator.

**Fail-closed denial, on every surface the token is used.** The scope is enforced
wherever the token acts — the MCP tools the agent drives **and** any direct API
call made with the raw token. When the agent attempts something outside its
scope (driving a run with a read-only token, reading members it wasn't granted),
the action is **refused fail-closed**: it does not run, nothing is changed, and a
clear "insufficient permission" error comes back. There is no fallback path that
quietly lets a denied action through.

**Every decision is audited — allowed and denied alike.** Allowed actions are
recorded in your access log under your identity plus the agent label, exactly as
described in [the audit guarantee](#5-the-audit-guarantee). **Denials are audited
too:** each refused action lands a row in your organization's audit log carrying
the agent label and the permission that was required, so a confined agent's
attempts are as visible as its successes. You can see both what your agent did
and what it was stopped from doing.

**Execution stays confined.** Beyond authorization, the workloads an agent
triggers run under the same execution guardrails as any other run — label-based
routing decides where a job runs, and privileged (root) execution is gated and
verified, refused fail-closed when the guarantee can't be met.

Together these mean you can hand an agent a deliberately narrow token, point it
at KiCI, and trust that it can do exactly what you granted — no more — with a
complete, tamper-evident trail of every allow and every deny.

## 7. Untrusted content and prompt injection

A run carries content KiCI does not vouch for — log lines, workflow and repository
names, error text, contributor names. An agent reading a run must treat that content
as **data**, never as instructions, or a crafted log line ("ignore previous
instructions and …") could hijack the agent.

KiCI defends this structurally:

- **Provenance tagging.** Every user- or process-controlled value is marked untrusted
  at the API boundary; KiCI's own values (run ids, statuses, exit codes, commit hashes)
  are trusted.
- **Fencing at the agent boundary.** When the MCP server returns a result, every
  untrusted value is wrapped in a per-response, randomly-named fence
  (`⟦u:<nonce>⟧…⟦/u:<nonce>⟧`) and the result is prefixed with a notice that fenced
  text is data, never instructions. The fence name is random per response, so injected
  content cannot forge a closing fence to break out.
- **No mutation.** KiCI never rewrites your log content — it fences and labels it. The
  agent sees the true bytes inside the fence.

### Safe integration pattern

An agent (or harness) consuming KiCI reads should treat anything inside a fence as
opaque data: quote it, summarize it, search it — but never execute it, follow it, or
let it redirect a tool call. Any action taken off the back of a read (re-run, cancel,
trigger) should be a deliberate decision from the trusted skeleton (statuses, exit
codes, the failure category), not from fenced content.

### Sandboxing actions

Actions an agent drives through KiCI run under the agent's own least-privilege identity
and are audited; combine the fencing contract with that confinement so that even if a
log line tries to provoke an action, the action is bounded by the agent token's scope.
