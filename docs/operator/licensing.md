---
title: Licensing FAQ
description: What you can and can't do with KiCI source code
---

KiCI is split across two OSS licenses plus three always-private packages. This page walks through what each license means for the people most likely to read it: workflow authors, self-hosters, and anyone thinking about forking or reselling KiCI.

Authoritative terms live in `/LICENSE` (Apache-2.0) and each package's own `LICENSE` file. The full per-package matrix is in [`LICENSES.md`](https://github.com/kici-dev/kici-public/blob/main/LICENSES.md) at the repo root. This page is the plain-English cheat sheet, not a legal document.

> This FAQ is informational only. It is not legal advice. For edge cases or a commercial license, email `licensing@kici.dev`.

## TL;DR table

| You are …                                             | Which packages matter                                                                                                                                                               | License       | What applies to you                                                                                                                          |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Writing KiCI workflows (`.kici/workflows/*.ts`)       | `@kici-dev/sdk`                                                                                                                                                                     | Apache-2.0    | Your workflow files are 100% yours. KiCI imposes no license on them.                                                                         |
| Running the `kici` CLI locally                        | 5 Apache-2.0: `kici`, `@kici-dev/compiler`, `@kici-dev/core`, `@kici-dev/sdk`, `@kici-dev/shared`. 3 AGPL-3.0-only: `@kici-dev/agent`, `@kici-dev/engine`, `@kici-dev/orchestrator` | mixed         | Installing and running these locally imposes no source-disclosure duty. AGPL §13 fires only if you offer KiCI as a service to third parties. |
| Self-hosting orchestrator + agent inside your company | `@kici-dev/orchestrator`, `@kici-dev/agent`, `@kici-dev/engine`, `kici-admin`                                                                                                       | AGPL-3.0-only | You can run and modify freely. No source disclosure required unless you offer the service to third parties (see below).                      |
| Offering a hosted KiCI service to outside customers   | All server-plane packages above                                                                                                                                                     | AGPL-3.0-only | AGPL §13 fires: you must publish your modifications under AGPL-3.0, or negotiate a commercial license with us.                               |
| Building the dashboard or Platform SaaS               | the dashboard and the Platform                                                                                                                                                      | (private)     | Not available as public source. These ship only inside our hosted offering.                                                                  |

## If you write KiCI workflows

Your `.kici/workflows/*.ts` files import from `@kici-dev/sdk`, which is Apache-2.0. The SDK's license does not reach through into workflows you write any more than `import React from 'react'` makes your app's code MIT. Ship your workflows under whatever license you like — proprietary, MIT, AGPL, nothing at all. Apache-2.0 asks only that downstream users keep the SDK's copyright notice and license text if they redistribute the SDK itself.

## If you install the `kici` CLI

`npm i kici` installs **eight** KiCI packages, not the one you asked for. Five are Apache-2.0 — `kici`, `@kici-dev/compiler`, `@kici-dev/core`, `@kici-dev/sdk`, `@kici-dev/shared` — and three are AGPL-3.0-only: `@kici-dev/agent`, `@kici-dev/engine`, `@kici-dev/orchestrator`. The compiler depends on them because `kici run <event> --local` executes a workflow on your machine using the same engine and agent the server plane uses.

**This imposes nothing on you.** The AGPL's source-disclosure obligation (§13) is triggered by _offering the software to third parties over a network_, not by installing or running it. Running a CLI on your own laptop, or in your own CI, is exactly the "internal use" case that never triggers copyleft. See [If you self-host orchestrator + agent internally](#if-you-self-host-orchestrator--agent-internally) below, which is the same analysis.

What it does mean, concretely: if your organisation runs an automated license scan over your dependency tree, `kici` will show up carrying AGPL-3.0-only transitive packages, and somebody may ask about it. The answer is the paragraph above. Your own workflow files and application code are unaffected either way — they only import `@kici-dev/sdk`, which is Apache-2.0.

## If you self-host orchestrator + agent internally

This is the core self-host path. Drop `@kici-dev/orchestrator` and `@kici-dev/agent` onto your own servers, wire up webhook delivery to your own Git host, run CI for your own team. AGPL-3.0 lets you:

- Read, fork, and modify the source.
- Run modified or unmodified versions on as many machines as you want, for as long as you want.
- Keep your modifications private as long as you are not offering the service to third parties. Internal use never triggers the copyleft.

What AGPL asks in return: if you distribute the binaries or source externally, do so under AGPL-3.0 and carry the license text. For a typical team running KiCI for their own CI, there is nothing new to do beyond keeping the license file in your deployment.

## If you offer KiCI as a hosted service to others

This is the scenario AGPL-3.0 was written for. §13 of AGPL-3.0 covers third-party users who interact with a modified version of the software over a network. You must offer them the corresponding source of your modifications, under AGPL-3.0, free of charge.

Two compliant paths:

1. **Full AGPL compliance.** Publish your modifications to orchestrator / agent / engine / kici-admin under AGPL-3.0, with a way for your users to download that source (a `/source` link on your dashboard, a public repo, etc.).
2. **Commercial license.** Email `licensing@kici.dev` to discuss a dual-licensing arrangement. No public price list yet — we negotiate case-by-case and expect to publish tiers once patterns emerge.

## Why the split?

Two bets:

- The SDK, compiler, and developer CLI are **tools you pair with KiCI from outside**. They should be maximally adoptable, hence Apache-2.0. Nobody wants to pick up a CI-definition library with a copyleft caveat attached.
- The orchestrator, agent, engine, and kici-admin are **the KiCI product itself**. Copyleft here means somebody who wants to offer a "KiCI-as-a-service" competitor cannot just do a verbatim rehost — they have to contribute their modifications back or negotiate commercially. Apache-2.0 on these packages would defeat the business model before it starts.

The dashboard and the multi-tenant SaaS Platform stay closed-source because they are the hosted commercial offering, not part of the reusable product surface.

## Edge cases

- **Internal fork for your own use.** Fine under AGPL. Keep the license file, you can do whatever you want internally. No source disclosure required because you aren't offering the service to third parties.
- **Closed-source plugin or extension to orchestrator.** AGPL is strict about "the program" — if your code links into the orchestrator's process, you likely fall under the same AGPL obligation. Safer pattern: build a standalone service that talks to the orchestrator over its HTTP / WS API instead of linking into it.
- **Sharing a self-hosted KiCI dashboard link inside your company.** Not "the public" in the sense of AGPL §13. No disclosure required.
- **Using `@kici-dev/engine` as a library in a non-KiCI product.** AGPL-3.0 reaches through. If your product is offered as a service to third parties, you'd have to AGPL-3.0 your product. This is intentional — the engine is the KiCI core IP.

## Getting a commercial license

Email `licensing@kici.dev` with a short description of your use case (what you're building, how it reaches users, rough scale). We'll reply with a starting point. Expect a conversation, not a self-serve checkout — we're early.
