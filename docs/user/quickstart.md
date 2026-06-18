---
title: 5-minute quickstart
description: Stand up a KiCI orchestrator + agent and run your first workflow
---

KiCI offers two equally-supported quickstart paths. Pick the one that fits your machine — both end with the same working pipeline (orchestrator + agent + your first workflow run visible in the dashboard).

Each guide is split into two parts. **Part 1** gets you a green run against your own orchestrator with `kici run remote` — no GitHub App needed, just sign up, bring up the stack, and run. **Part 2** then wires up real GitHub pushes so your team's commits trigger runs automatically. You can stop after Part 1 and come back to Part 2 whenever you're ready.

## Option A — Docker / Podman (recommended)

Two containers brought up with `docker compose up -d` (orchestrator + PostgreSQL), plus one short-lived agent container spawned per job by the container scaler. Minimal host setup, perfect for a laptop, home server, or a tiny VM. No need to install PostgreSQL or any other system service.

[Start with the Docker / Podman quickstart →](./quickstart/compose.md)

## Option B — Bare-metal install

Native systemd services managed by `kici-admin orchestrator install` / `kici-admin agent install` — the orchestrator and agents run as native processes. The backing PostgreSQL runs as a single container by default (one `docker compose up -d`), or you can install it natively if you'd rather not run a container runtime at all. Best for a long-lived Linux host.

[Start with the bare-metal quickstart →](./quickstart/bare-metal.md)

## Which should I pick?

|                           | Docker / Podman                          | Bare metal                                                                            |
| ------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------- |
| Host requirements         | `docker` or `podman` with compose v2.20+ | systemd, Node.js 24+, PostgreSQL 18 (container — needs `docker`/`podman` — or native) |
| First local run (Part 1)  | ~5 minutes                               | ~10 minutes                                                                           |
| First GitHub run (Part 2) | + ~10 minutes                            | + ~10 minutes                                                                         |
| Upgrades                  | `docker compose pull` + restart          | `kici-admin orchestrator restart` after `npm install -g kici-admin@latest`            |
| Best for                  | Quick evaluation, ephemeral hosts        | Long-lived production hosts                                                           |

If you're not sure, pick Docker / Podman.

## Looking for the laptop-only path?

Both quickstarts deploy a real orchestrator + agent. If you only want to write a workflow and dry-run it on your laptop with no infrastructure, [Getting started](./getting-started.md) covers `kici test` and `kici run local` instead.
