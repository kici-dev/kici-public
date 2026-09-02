---
title: Reporting a discrepancy
description: For coding agents — how to report a mismatch between what KiCI's docs advertise and what the tooling does, with the reproduction and the approval a report needs.
---

This page is addressed to a **coding agent** working with KiCI. KiCI is built to
be driven by an LLM, so an agent is often the first to notice a mismatch. A
documented flag does not exist; a command prints something the docs never
promised. You can report that.

A human reader can use this page too. The rules below exist because the tracker
is public and you are filing under someone else's GitHub identity.

Run `kici feedback` to print this contract in your terminal, or
`kici feedback --json` to read it as structured data.

## The rule, in one sentence

You find a checkable mismatch between what the docs or the CLI advertise and
what KiCI actually does. You draft an issue carrying a reproduction and a
justification, and show it to the person you are working with. You file it only
after they say yes.

You never file on your own initiative.

## What qualifies

Report it when you can point at the claim and at the contradicting behaviour:

- A documented flag, command, or option that does not exist in the version you ran.
- Documented output — a shape, a field, an exit code — that differs from what the command produced.
- A CLI `--help` description that contradicts the published docs.
- A documented behaviour that does not happen, or a documented guarantee that does not hold.
- A documented error or limit that the tool does not actually enforce.

Two conditions apply to all of them. You ran the command and saw the result —
inference from reading the docs is not a reproduction. And you ran a published
version: check with `kici --version`.

## What does not qualify

- Usage questions, or behaviour you find surprising but that the docs describe correctly.
- Feature requests and design preferences.
- Anything you inferred from reading docs without running the command.
- Anything reproduced only on a locally built or unreleased version.
- A failure that is your workflow, your credentials, or your environment.

If you are unsure whether the docs are wrong or you misread them, you are not
ready to file. Say so to the person you are working with and let them decide.

## Never file these publicly

**A suspected vulnerability is never a public issue.** Do not file it, and do
not describe it in one. Open a private
[security advisory](https://github.com/kici-dev/kici-public/security/advisories/new)
instead, or tell the person you are working with to. This holds even if the
issue looks minor to you.

**A problem with someone's own runs is not a tracker issue.** That covers a
failing run, a broken deployment, and anything that needs their logs. Use the
private path in [Getting help](./getting-help.md) instead:
`kici report --run <run-id> --upload` sends a redacted bundle straight to KiCI.

**Never put customer data in a public issue:**

- No secrets, tokens, or credentials — not even redacted-looking ones.
- No private repository names, internal hostnames, organization ids, or run ids.
- No log excerpts you have not read line by line.
- Reproduce with a minimal synthetic workflow, never the real one you were working on.

Rewriting the reproduction against a throwaway workflow in an empty directory is
the reliable way to satisfy all four at once.

## Search before you draft

The tracker is small. The same finding arriving once per agent that reads the
docs is worse than not hearing it at all:

```bash
gh issue list --repo kici-dev/kici-public --search "<terms>" --state all
```

Search closed issues too — a closed one may carry the answer, or the decision
that the behaviour is intended. If a matching issue is open, add your
reproduction as a comment instead of opening a second one, under the same
approval rule.

## What the report must carry

Five things. A report missing any of them cannot be acted on:

| Field                                 | What it holds                                                                                                        |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| What the docs or CLI advertise        | The exact claim, quoted, plus its source: a docs URL or the command whose `--help` says it.                          |
| What actually happened                | The real output or behaviour, quoted, with any error text.                                                           |
| Minimal reproduction, including setup | Every step from an empty directory: the setup commands, a minimal synthetic workflow, and the exact command you ran. |
| Version and environment               | Output of `kici --version`, plus Node version and OS.                                                                |
| Why this is a discrepancy             | One or two sentences ruling out the likely misreads — why the docs cannot be read to match what you observed.        |

The last field is the one agents skip, and it is the one that makes a report
usable. "The docs say `--foo` exists and it does not" is a claim. "`--foo` is
documented at <url>, and `kici bar --help` on 0.1.16 lists no such flag" is a
finding someone can act on in one pass.

Include setup steps whenever your reproduction needed any. A reproduction that
starts from state a maintainer cannot recreate is not a reproduction.

## Filing it

The tracker is [kici-dev/kici-public](https://github.com/kici-dev/kici-public),
and the form is **Agent report**:

```bash
kici feedback --open
```

Draft the complete body first. Show it to the person you are working with —
the whole body, not a summary of it. File only after they say yes:

```bash
gh issue create --repo kici-dev/kici-public --template agent_report.yml
```

The form asks you to confirm the report was drafted by an agent and reviewed by
a person before filing. Answer honestly; it is what lets maintainers triage
agent-filed reports as a group.

If they say no, that is the end of it. Do not re-file the same finding in
another form, and do not open it as a question instead.

## See also

- [Getting help](./getting-help.md) — the private path for a problem with your own runs
- [Drive KiCI from your coding agent](./ai-agents.md) — the MCP server, and the agent safety model
- [Common failures](./common-failures.md) — check here before concluding the docs are wrong
