---
title: Common failures
description: Symptom-to-fix reference for the failures workflow authors hit most — no jobs dispatched, lock-file drift, missing webhooks, and agents that won't connect
---

When a run misbehaves, start here. Each section below is a **symptom you can
observe** (a message, a missing run, a stuck job), the **cause** behind it, the
**one command** that confirms the diagnosis, and the **fix**. Everything on this
page uses the developer tools you already have — the `kici` CLI and the
dashboard. For orchestrator-side diagnostics (scaler spawn failures, the webhook
delivery log, agent registration internals), your operator has a deeper
companion at [Operator troubleshooting](../operator/troubleshooting.md).

## Fast triage

| You see...                                                     | Jump to                                                 |
| -------------------------------------------------------------- | ------------------------------------------------------- |
| A run finishes with `No jobs dispatched`                       | [No jobs dispatched](#no-jobs-dispatched)               |
| A run fails complaining the lock file is stale or incompatible | [Lock-file drift](#lock-file-drift)                     |
| You pushed but no run ever appears                             | [The webhook never arrives](#the-webhook-never-arrives) |
| A run is stuck "queued" and no agent ever picks it up          | [The agent won't connect](#the-agent-wont-connect)      |

## No jobs dispatched

**Symptom.** A trigger matched a workflow, but the run ends immediately with
`No jobs dispatched (all matched workflows had no static jobs or dispatch was
rejected)`, or a job sits queued and the dashboard shows `No matching agent
available`.

**Cause.** A job's `runsOn` label set matches **no agent** the orchestrator's
scaler can provide. The orchestrator evaluates the lock file, finds the matching
workflow, but no online (or spawnable) agent carries the requested labels, so it
has nothing to dispatch to.

The most common trigger is a **GitHub-hosted runner label**. KiCI agents are
labeled with `kici:os:linux`, `kici:arch:*`, and whatever custom labels your
scaler declares (for example `container` or `bare-metal`).

<!-- kici-lint-allow-github-runner: contrast line explaining GitHub labels never match a KiCI agent -->

A value like `ubuntu-latest` is a GitHub label — it matches no KiCI agent and never dispatches.

**Diagnose.** Two commands:

- `kici diagnostics` lists every connected orchestrator, its scalers, and the
  labels its agents report. Confirm an agent (or a scaler that can spawn one)
  actually carries the label your job asks for.
- `kici preview push --branch main` shows which workflows and jobs a trigger
  would match, without executing anything — use it to see the `runsOn` your job
  resolves to.

**Fix.** Set the job's `runsOn` to a label your scaler provides — an auto-label
every agent reports (`'kici:os:linux'`) or a custom scaler label (`'container'`)
— then `kici compile` and push (or re-run). See
[the `runsOn` forms](./sdk/core.md#runson-forms) for how a job selects agents by
label.

## Lock-file drift

**Symptom.** A run fails at init (before any step runs) with one of:

- `Lock file is out of date: workflow source changed without regenerating
kici.lock.json ...`
- a schema-version message for a lock **older** than the orchestrator's
  compatibility window: `Lock file schema vX predates the oldest supported
version vY — recompile with a current SDK ('kici compile') and push again.`
- a schema-version message for a lock **newer** than the window, naming the
  orchestrator version it needs: `Lock file requires orchestrator schema vX or
newer but this orchestrator understands up to vY — upgrade the orchestrator to a
newer version.`
- a "stale or compiled by an older engine — recompile with `kici compile`"
  message about an invalid label matcher.

**Cause.** The committed `kici.lock.json` no longer matches the workflow source
at that commit, or it was compiled by a different toolchain version than the one
your orchestrator and agents run. KiCI reads only the lock file to route
triggers, and the agent re-verifies the workflow source hash before running, so
any mismatch is rejected loudly rather than run against stale routing.

**Diagnose.** From the workflow repo, recompile and check whether the lock file
changes:

    kici compile

If `kici.lock.json` shows up as modified in `git status` afterward, it was out of
date. The orchestrator reads a compatibility window of lock schema versions, so a
schema message means your lock fell outside that window: a lock **below the floor**
is too old and must be recompiled against your current toolchain, while a lock
**above the window** was compiled by an SDK newer than your orchestrator and needs
the orchestrator upgraded.

**Fix.** For a too-old lock, run `kici compile`, commit the regenerated
`kici.lock.json`, and push again. For a lock that needs a newer reader, upgrade
the orchestrator to the version the error names. Never force an out-of-window lock
through. Full detail on the two-artifact model, the compatibility window, and how
the hashes are computed is in
[Lock file and workflow drift](./lock-file-and-drift.md).

## The webhook never arrives

**Symptom.** You pushed a commit (or opened a PR), but **no run appears** in the
dashboard at all.

**Cause.** One of two things: the provider never delivered the webhook to the
Platform, or the orchestrator received it but **nothing matched** — no workflow
triggered, or the repo had no lock file at that commit.

**Diagnose.** Work from the outside in:

1. **Did the provider deliver?** In your GitHub App's settings, open the
   **Recent deliveries** tab and look for non-2xx responses. A 4xx there means
   the delivery was rejected before any workflow ran (usually a signature or
   source-registration mismatch).
2. **Did anything match?** Run `kici preview push --branch <your-branch>`
   against your workflow. If it reports no matching workflow, your triggers don't
   cover that event/branch — the push was delivered and simply matched nothing.
3. **Was there a lock file?** A repository with **no** `kici.lock.json` at the
   pushed commit produces no run and is not an error. Confirm the lock file is
   committed and current (see [Lock-file drift](#lock-file-drift)).

The dashboard's Event log (under your org settings) records each delivery and
whether it matched, was a duplicate, or found no lock file — check it to see
which of the above happened.

**Fix.** Depending on which step failed: re-check the webhook secret and source
registration (a 4xx delivery), broaden the workflow's triggers (`kici preview`
matched nothing), or commit the lock file (no lock at that commit). The
[Docker/Podman quickstart troubleshooting](./quickstart/compose.md#troubleshooting)
walks through the provider-side wiring in detail.

## The agent won't connect

**Symptom.** A job sits queued and no agent ever picks it up, or the orchestrator
logs show an agent connecting and immediately dropping.

**Cause.** Usually one of:

- **Authentication.** The agent's token is wrong or was revoked. The
  orchestrator closes the connection and the agent does **not** retry a bad
  token, so it never registers.
- **An ID conflict.** Two agents registered with the same agent ID but different
  tokens, and the later one is refused.
- **Provisioning.** An ephemeral agent failed to start before it could connect —
  a missing binary (`spawn node ENOENT` on a bare-metal scaler), an image that
  won't pull, or a microVM that won't boot. No step logs exist because the agent
  never ran.

**Diagnose.** `kici diagnostics` shows whether any agent is currently registered
and what its scalers report. If the failure is a provisioning one (no agent ever
came up), the captured error surfaces as the run's failure reason and in the
dashboard's **Provisioning logs**. Your operator can confirm the backend could
not spawn an agent with `kici-admin diagnose` — the `scaler:<name>` row carries
the captured error.

**Fix.** For a token problem, mint a fresh agent token and restart the agent. For
a provisioning problem, the fix is on the orchestrator host (the missing binary,
the unpullable image) — hand this to your operator with the run's failure reason.
The full provisioning-failure playbook is in
[Operator troubleshooting](../operator/troubleshooting.md).

## When to escalate to your operator

The failures above are ones you can resolve from your workflow repo and the
`kici` CLI. Anything that lives on the orchestrator host — scaler configuration,
the webhook delivery log, agent registration internals, database or storage
problems — belongs to whoever operates your orchestrator. Point them at
[Operator troubleshooting](../operator/troubleshooting.md) and include the run's
failure reason (from the dashboard run detail or `kici runs show <runId>`).
