---
title: Why KiCI
description: The case for running CI on infrastructure you control, with typed TypeScript workflows you test locally
---

Most CI platforms ask you to hand your source, your secrets, and your build machines to someone else. KiCI is built the other way around: your code runs on infrastructure you control, and you describe the pipeline in real TypeScript you can run before you push. This page is the short argument for that trade -- what it buys you, and what it costs.

## Your infrastructure runs the code

KiCI is a three-tier relay. The hosted platform is a thin webhook router: it verifies the incoming webhook signature and relays the event to your orchestrator over a WebSocket. Your **orchestrator** decides what to run and dispatches jobs to your **agents**, which clone the repository, execute the steps, and stream logs back. The orchestrator and agents run on machines you own.

Because of that split, the hosted platform sees only the envelope, never the payload:

- **What it receives:** the webhook event, run metadata (workflow and job names, statuses, timings), aggregate operational metrics, and log lines while you are streaming them to the dashboard.
- **What it never sees:** your source, your secrets, your artifacts, or your signing material. Those stay on your orchestrator and agents. Log content is relayed only in transit for the live dashboard view -- the platform never stores it.

The hosted platform is operated by KiCI; you do not run your own. What you run is the orchestrator and the agents, and that is where every byte of your code and every secret lives. For the field-level breakdown of what does and does not leave your infrastructure, see [Data residency](../operator/data-residency.md), and for the honest security posture of self-hosting the agents, see [Is self-hosting the agents a security risk?](../operator/security/self-hosting-security.md).

## Workflows are TypeScript

A KiCI workflow is a TypeScript program, not a YAML document. Jobs, steps, triggers, and matrices are typed values you compose with the full language -- loops, conditionals, functions, `async`/`await`, and your editor's autocompletion and type checking. Invalid pipelines fail at compile time, in your editor, instead of failing on the tenth push.

The same TypeScript runs everywhere. `kici run --local` executes your workflow on your own machine against a simulated event, and that is the same execution model the agents use in production. Your local run is the production pipeline, so you debug a green run before it ever reaches a source event. This also makes workflows something an AI coding agent can author, type-check, and run before it opens a pull request.

## The honest trade

Running your own infrastructure is not free. You operate the orchestrator: a Docker / Podman or bare-metal service you stand up (in minutes for the quickstart topology), keep patched, back up, and upgrade. In exchange, you own your data, your egress, and your isolation model -- no third party executes your code or holds your secrets. KiCI is pre-1.0, so pin versions for production. See [Deploying the orchestrator](../operator/orchestrator/getting-started.md) for what running it involves.

## Compared to specific tools

If you are weighing KiCI against a specific incumbent -- GitHub Actions, GitLab CI, CircleCI, Jenkins, Buildkite, and others -- the point-by-point comparisons live on the marketing site, kept current with sourced references. Start with the [GitHub Actions comparison](https://kici.dev/compare/github-actions), or browse [all comparisons](https://kici.dev/compare).

## Next steps

- **[Green run in ~5 minutes](quickstart.md)** -- stand up an orchestrator and agent and watch a workflow go green.
- **[Getting started](getting-started.md)** -- write your first workflow and test it locally.
